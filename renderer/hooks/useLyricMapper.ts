import { createSignal } from 'solid-js';

import { createIpcListener } from './createIpcListener';

import { LyricMapper } from '../../common/schema';

const useLyricMapper = () => {
  const [lyricMapper, setLyricMapper] = createSignal<LyricMapper>({});

  window.ipcRenderer.invoke('get-lyric-mapper').then((result: LyricMapper) => {
    setLyricMapper(result || {});
  });

  createIpcListener(
    () => 'lyric-mapper',
    (_, data: LyricMapper) => {
      setLyricMapper(data);
    },
  );

  const setMapper = async (newMapper: Partial<LyricMapper>) => {
    await window.ipcRenderer.invoke('set-lyric-mapper', newMapper);
  };

  return [lyricMapper, setMapper] as const;
};

export default useLyricMapper;
