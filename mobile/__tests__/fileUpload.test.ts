import {NativeModules} from 'react-native';
import {canUploadFiles, pickFiles, uploadFile} from '../src/files';
import {runUploads, uploadReport, uploadValue} from '../src/files/upload';

// the upload action (UI contract 1.2), the app's side: the same decisions as Mission Control's
// (mission_control/tests/upload.test.mjs), and the native module's picker and streamed POST
const action = {
  route: 'upload?name={$value.name}',
  conflict: {confirm: 'Replace it?', route: 'upload?name={$value.name}&overwrite=1'},
};

function host(answers: any[], replace = true) {
  const sent: string[][] = [];
  const asked: string[] = [];
  return {
    sent,
    asked,
    url: (template: string, value: {name: string}) =>
      template.startsWith('..') ? null : `/api/satellites/Any/${template.replace('{$value.name}', encodeURIComponent(value.name))}`,
    send: async (url: string, file: {name: string}) => {
      sent.push([url, file.name]);
      const answer = answers.shift();
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
    confirm: async (value: {name: string}) => {
      asked.push(value.name);
      return replace;
    },
  };
}

describe('uploading files', () => {
  afterEach(() => {
    delete (NativeModules as any).StarCoreFiles;
  });

  it("gives each file a safe name and its size as $value", () => {
    expect(uploadValue({name: 'notes.txt', size: 12})).toEqual({name: 'notes.txt', size: 12});
    expect(uploadValue({name: '../a:b.txt', size: 3})).toEqual({name: '_a_b.txt', size: 3});
    expect(uploadValue({name: '', size: -1})).toEqual({name: 'upload', size: 0});
  });

  it('sends each file in turn, retries a conflict once confirmed, and skips one declined', async () => {
    const files = [{name: 'a.txt', size: 1}, {name: 'b.txt', size: 1}];
    const replaced = host([{status: 409, payload: {}}, {status: 200, payload: {}}, {status: 200, payload: {}}]);
    expect(await runUploads(files, action, replaced)).toEqual({uploaded: ['a.txt', 'b.txt'], skipped: [], failed: []});
    expect(replaced.sent.map(([url]) => url)).toEqual([
      '/api/satellites/Any/upload?name=a.txt',
      '/api/satellites/Any/upload?name=a.txt&overwrite=1',
      '/api/satellites/Any/upload?name=b.txt',
    ]);
    expect(replaced.asked).toEqual(['a.txt']);

    const kept = host([{status: 409, payload: {}}, {status: 200, payload: {}}], false);
    const result = await runUploads(files, action, kept);
    expect(result).toEqual({uploaded: ['b.txt'], skipped: ['a.txt'], failed: []});
    expect(uploadReport(result)).toEqual({text: 'Uploaded 1 of 2 files. Kept the existing a.txt.', error: false});
  });

  it('reports failures, and a 409 without a conflict route as one', async () => {
    const failing = host([{status: 409, payload: {error: 'exists'}}, new Error('network down'), undefined]);
    const result = await runUploads(
      [{name: 'a.txt', size: 1}, {name: 'b.txt', size: 1}, {name: 'c.txt', size: 1}],
      {route: 'inbox?name={$value.name}'},
      failing,
    );
    expect(failing.asked).toEqual([]);
    expect(result.failed).toEqual([
      {name: 'a.txt', error: 'exists'},
      {name: 'b.txt', error: 'network down'},
      {name: 'c.txt', error: 'the upload failed'},
    ]);
    expect(uploadReport(result)).toEqual({
      text: 'Uploaded 0 of 3 files. Could not upload a.txt (exists); b.txt (network down); c.txt (the upload failed).',
      error: true,
    });
    expect(uploadReport({uploaded: ['a.txt'], skipped: [], failed: []}).text).toBe('Uploaded a.txt.');

    const outside = host([]);
    const refused = await runUploads([{name: 'a.txt', size: 1}], {route: '../x'}, outside);
    expect(outside.sent).toEqual([]);
    expect(refused.failed[0].error).toMatch(/outside its Satellite/);
  });

  it('picks and uploads through the native module, with the session header', async () => {
    expect(canUploadFiles()).toBe(false);
    await expect(pickFiles(true)).rejects.toThrow('not available');
    const pick = jest.fn(async () => [{uri: 'content://docs/1', name: 'a.txt', size: 3}]);
    const upload = jest.fn(async () => ({status: 409, body: '{"error": "exists"}'}));
    (NativeModules as any).StarCoreFiles = {canUpload: true, pick, upload};
    expect(canUploadFiles()).toBe(true);
    const [file] = await pickFiles(false);
    expect(pick).toHaveBeenCalledWith(false);
    expect(file).toEqual({uri: 'content://docs/1', name: 'a.txt', size: 3});
    const target = {uri: 'https://s.test/api/satellites/Any/upload?name=a.txt', headers: {Authorization: 'Bearer t'}};
    await expect(uploadFile(file, target)).resolves.toEqual({status: 409, payload: {error: 'exists'}});
    expect(upload).toHaveBeenCalledWith('content://docs/1', target.uri, {Authorization: 'Bearer t'});
    upload.mockResolvedValueOnce({status: 502, body: '<html>bad gateway</html>'});
    await expect(uploadFile(file, target)).resolves.toEqual({status: 502, payload: null});
  });
});
