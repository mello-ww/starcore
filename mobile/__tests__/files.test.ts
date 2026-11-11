import {NativeModules, Platform} from 'react-native';
import {canSaveFiles, canShareFiles, fileName, saveFile, shareFile} from '../src/files';

// the download and share actions (UI contract 1.2), the app's side: the same file name rule as
// Mission Control's, and the native module's own answer to what this phone can do
describe('file actions', () => {
  afterEach(() => {
    delete (NativeModules as any).StarCoreFiles;
  });

  it('names a file from the document, made safe, else from its route', () => {
    expect(fileName('IMG_0042.jpg', 'originals/abc')).toBe('IMG_0042.jpg');
    expect(fileName('  holiday photo.png ', 'originals/abc')).toBe('holiday photo.png');
    expect(fileName('../../etc/passwd', 'originals/abc')).toBe('_.._etc_passwd');
    expect(fileName('a:b*c?"d<e>f|g\\h\u0000.txt', 'x')).toBe('a_b_c__d_e_f_g_h_.txt');
    expect(fileName('', 'originals/abc?size=2')).toBe('abc');
    expect(fileName(null, 'reports/latest')).toBe('latest');
    expect(fileName('...', 'files/')).toBe('download');
    expect(fileName('x'.repeat(300), 'y')).toHaveLength(120);
  });

  it('offers nothing without the native module', async () => {
    expect(canSaveFiles()).toBe(false);
    expect(canShareFiles()).toBe(false);
    await expect(saveFile({uri: 'https://s.test/a'}, 'a.jpg')).rejects.toThrow('not available');
  });

  it('asks the native module, with the session header and the safe name', async () => {
    const save = jest.fn(async () => ({name: 'a.jpg'}));
    const share = jest.fn(async () => true);
    (NativeModules as any).StarCoreFiles = {canSave: false, canShare: true, save, share};
    expect(Platform.OS).toBe('android');
    expect(canSaveFiles()).toBe(false);  // an Android older than 10
    expect(canShareFiles()).toBe(true);
    const source = {uri: 'https://s.test/api/satellites/Any/originals/1', headers: {Authorization: 'Bearer t'}};
    await shareFile(source, 'a.jpg');
    expect(share).toHaveBeenCalledWith(source.uri, {Authorization: 'Bearer t'}, 'a.jpg');
    await expect(saveFile(source, 'a.jpg')).resolves.toBe('a.jpg');
    expect(save).toHaveBeenCalledWith(source.uri, {Authorization: 'Bearer t'}, 'a.jpg');
  });
});
