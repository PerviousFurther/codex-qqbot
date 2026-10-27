import { z } from 'zod';
import { Files } from '../files.mjs';
import { ProjectFiles } from '../project-files.mjs';
import { contentCodecs } from '../content-codecs.mjs';
import { fileType } from '../file-codecs.mjs';
import { toolFailure } from './register.mjs';

export function registerFileTools(register, context, { allowProjectFiles = false, projectRoot = '/workspace/project' } = {}) {
  const files = new Files(context); const project = allowProjectFiles ? new ProjectFiles(projectRoot) : null;
  const area = z.enum(project ? ['workspace', 'memory', 'assets', 'project'] : ['workspace', 'memory', 'assets']).default('workspace');
  const name = z.string().min(1).max(300).describe('Flat workspace/memory filename; assets use an opaque asset_id; project uses an allowed relative source path.');
  const failure = error => toolFailure(error, error.message === 'FILE_GIF_DURATION_LIMIT'
    ? 'The full video exceeds the 15-second GIF limit. Tell the user that saving it as GIF was refused. Do not crop, truncate, retry or silently switch formats. A video file may be saved only as a deliberate separate choice.'
    : 'Report the file error accurately. Do not claim unviewed media was understood or bypass file/source permissions. Nothing executes. Oversize files need smaller input or explicit supported encoding; failed output is not published.');
  register('list_files', 'List persistent selected files in this conversation workspace, shared Markdown memory, or retained browser/image assets. Files are not automatically loaded into context. Use area=memory for optional shared public knowledge; never put private chat bodies or identities there. Project area is read-only and available only for an explicit current verified-administrator project request. No arbitrary host paths.', { area, query: z.string().max(100).default('') }, async args => {
    const result = args.area === 'project' ? await project.list(args.query) : args.area === 'assets' ? { files: await context.savedImages.list(context.scope, args.query) }
      : { ...(await (args.area === 'memory' ? files.memory : files.workspace).list()) };
    if (['workspace', 'memory'].includes(args.area)) result.files = result.files.filter(file => !args.query
      || `${file.name} ${file.label ?? ''}`.toLowerCase().includes(args.query.toLowerCase())).map(file => ({ ...file, ...fileType(file.name) }));
    return [contentCodecs.value('json', result)];
  }, failure);
  register('read_file', 'Read a selected stored file using the same extension/signature codecs as saving. Text returns bounded UTF-8 line excerpts; images return actual pixels; video/audio/other files return metadata, not understood content. Saved video/GIF can be decoded with read_media(file_name,turn_id,...). area=memory reads optional shared Markdown notes; area=assets reads retained browser/image pixels by asset_id. Project reads require the explicit current administrator request and permitted relative paths. No arbitrary filesystem access, execution, imports or automatic recall.', {
    area, name, start_line: z.number().int().min(1).max(100000).default(1), max_lines: z.number().int().min(1).max(200).default(100),
  }, async args => args.area === 'project' ? [contentCodecs.value('json', await project.read(args.name, args.start_line, args.max_lines))] : files.read(args.name, args.area, args.start_line, args.max_lines), failure);
  register('save_file', 'Selectively save a file, without sending or scheduling it. Choose exactly one source: generated text, an obtained allowlisted public URL (never adult websites or pornography), a current-conversation attachment_id/image_id, or a browser/saved-image asset_id. Browser screenshots/player frames already have asset IDs; no arbitrary browser fetch/evaluation, cookies, host paths or automatic attachment caching. Filename extension chooses text/image/video/audio/binary encoding and signatures are checked. format=auto (default) compresses MP4 output and otherwise preserves bytes; format=original always preserves bytes; QQ-compressed MP4 also stays unchanged for format=video unless bitrate_kbps is explicit. format=gif converts the ENTIRE video, only up to 15 seconds: reject longer/unknown duration, never crop or change speed. GIF uses fps/width/palette rather than target bitrate. format=video encodes MP4 at the selected bitrate; format=audio extracts/re-encodes MP3. Limits per output: text 64 KiB, images/GIF 16 MiB, audio 8 MiB, video/other binary 64 MiB; source download 64 MiB. Failed/oversize output is removed. area=memory accepts generated public Markdown text only; AGENTS.md is protected. No file-count quota. Explicit overwrite is required to replace an existing file. Saved workspace files survive context refresh and remain until explicitly deleted or scoped records are cleared. Saving media does not mean it was understood.', {
    area: z.enum(['workspace', 'memory']).default('workspace'), name: z.string().min(1).max(180),
    text: z.string().max(65536).optional(), url: z.string().url().max(2048).optional(),
    attachment_id: z.string().regex(/^[a-f0-9]{32}$/).optional(), image_id: z.string().regex(/^[a-f0-9]{32}$/).optional(), asset_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
    label: z.string().max(120).default(''), overwrite: z.boolean().default(false),
    format: z.enum(['auto', 'original', 'gif', 'video', 'audio']).default('auto'), bitrate_kbps: z.number().int().min(32).max(10000).optional(),
    fps: z.number().int().min(1).max(15).default(10), width: z.number().int().min(64).max(640).default(480),
  }, async (args, extra = {}) => [contentCodecs.value('json', await files.save(args, { signal: extra.signal }))], failure);
  register('delete_file', 'Delete one selected workspace file, shared note or retained asset. Does not recall sent messages. Shared AGENTS.md is protected; project files cannot be deleted. No directory deletion or arbitrary paths.', { area, name }, async args => {
    if (args.area === 'project') throw new Error('PROJECT_READ_ONLY');
    if (args.area === 'assets') return [contentCodecs.value('json', await context.savedImages.remove(context.scope, args.name))];
    const storage = args.area === 'memory' ? files.memory : files.workspace;
    if (args.area === 'workspace') {
      const file = await files.workspace.load(args.name); await file.assertAccess();
      return [contentCodecs.value('json', await files.workspace.removeFile(args.name, file.sha256))];
    }
    return [contentCodecs.value('json', await storage.remove(args.name, await storage.readText(args.name)))];
  }, failure);
  return files;
}
