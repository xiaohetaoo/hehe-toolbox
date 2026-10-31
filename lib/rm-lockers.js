const fs = require('fs');
const path = require('path');

/* 文件占用解锁：用 Restart Manager (RM) 的 C# 内嵌实现。
 *
 * 【为什么用 Restart Manager 而不是 handle.exe】
 * handle.exe 是 Sysinternals 的第三方 exe：要下载、要 EULA、还会被杀软报毒。
 * Restart Manager 是 Windows 自带的（Windows Installer / 更新服务用它判断
 * 「哪个进程占着文件」，重启管理器据此决定要重启谁），API 在 rstrtmgr.dll，
 * 不需要任何外部依赖，也不需要管理员权限就能**查询**。
 *
 * 【API 流程】
 *   RmStartSession → RmRegisterResources(文件路径) → RmGetList 取进程列表
 *   拿到后 RmEndSession 释放（必须，否则 session 计数会耗尽 —— 系统上限 64）
 *   RmGetList 需要先用 dwSessionHandle 查里；
 *   第一次调用返回 ERROR_MORE_DATA(234) 并给出实际数量，再分配缓冲重取。
 *
 * 【为什么这些常量是这个值】
 *   CCH_RM_SESSION_KEY = 32（宽字符 session key 长度）
 *   CCH_RM_MAX_APP_NAME = 255
 *   CCH_RM_MAX_SVC_NAME  = 63
 * 这些是 WIN32 头文件里的固定定义，不能改。
 */

const FILES_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace HeheFiles {
  public class LockInfo {
    public int Pid;
    public string Name;
    public string Type;      // "app" 或 "service"
    public string Sid;
    public string FullName;
  }

  public class Util {
    const int CCH_RM_SESSION_KEY = 32;
    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;
    const int ERROR_MORE_DATA = 234;
    const int ERROR_SUCCESS = 0;

    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS {
      public int dwProcessId;
      public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
      public RM_UNIQUE_PROCESS Process;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
      public string strAppName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
      public string strServiceShortName;
      public int ApplicationType;
      public uint AppStatus;
      public uint TSSessionId;
      [MarshalAs(UnmanagedType.Bool)]
      public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle,
      uint nFiles, string[] rgsFilenames,
      uint nApplications, RM_UNIQUE_PROCESS[] rgApplications,
      uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded,
      ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps,
      ref uint lpdwRebootReasons);

    /// <summary>查哪些进程占用给定文件。返回 TSV 文本，每行：
    /// pid \t name \t type \t reasons
    /// 【第 4 列是「本次查询的重启原因」，不是文件全名】
    /// RmGetList 的 lpdwRebootReasons 是每次查询一个整体值，所以同一批里
    /// 所有行的这一列都相同（例如 1 表示需要重启才能释放）。
    /// 早期这里的注释写的是 fullName，照着注释去解析第 4 列会得到一串数字，
    /// 以为是路径。要看目标文件请用主进程传进来的 paths。</summary>
    public static string Lockers(string[] paths) {
      uint session = 0;
      var key = new StringBuilder(CCH_RM_SESSION_KEY + 1);
      int rc = RmStartSession(out session, 0, key);
      if (rc != ERROR_SUCCESS) return "ERR\tsession\t" + rc;
      try {
        rc = RmRegisterResources(session, (uint)paths.Length, paths, 0, null, 0, null);
        // 关键：路径不存在时 RM 也会返回成功但列表为空，所以要靠上层先验证存在
        if (rc != ERROR_SUCCESS) return "ERR\tregister\t" + rc;

        uint needed = 0, count = 0;
        uint reasons = 0;
        RM_PROCESS_INFO[] arr = new RM_PROCESS_INFO[0];
        rc = RmGetList(session, out needed, ref count, arr, ref reasons);
        if (rc == ERROR_MORE_DATA) {
          // 预期中的「第一次先问数量」：按 needed 分配再取
          count = needed;
          arr = new RM_PROCESS_INFO[needed];
          rc = RmGetList(session, out needed, ref count, arr, ref reasons);
        }
        if (rc != ERROR_SUCCESS) return "ERR\tlist\t" + rc;

        var sb = new StringBuilder();
        for (uint i = 0; i < count; i++) {
          var p = arr[i];
          string type = p.ApplicationType == 1 ? "service" : "app";
          string name = p.strAppName;
          if (type == "service" && p.strServiceShortName.Length > 0) name = p.strServiceShortName;
          // 进程名从 PID 取不到时（已退出）留空
          sb.Append(p.Process.dwProcessId).Append('\t')
            .Append(name.Replace('\t',' ')).Append('\t')
            .Append(type).Append('\t')
            .Append(reasons).Append('\n');
        }
        return sb.ToString();
      } finally {
        // 必须关：系统的 RM session 上限是 64，泄漏会耗尽
        RmEndSession(session);
      }
    }
  }
}
`;

module.exports = { FILES_CS };
