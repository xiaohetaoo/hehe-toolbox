import { Composition } from 'remotion';
import { HehePromo, TOTAL } from './Main';

export const Root: React.FC = () => {
  return (
    <Composition
      id="HehePromo"
      component={HehePromo}
      defaultProps={{ bgm: true }}
      durationInFrames={TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};