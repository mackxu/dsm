import { existsSync } from 'node:fs';
import path from 'node:path';

import { extractArchive } from './archive.ts';
import {
  createApiClientForConfig,
  downloadArchive,
  getCurrentUser,
  getProject,
  uploadFile,
} from './gitlab-api.ts';
import {
  loadConfig,
  parseArgs,
  showHelp,
  validateLocalInputs,
} from './config.ts';

function createTimestamp(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  );

  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${String(
    Date.now() % 1000,
  ).padStart(3, '0')}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    showHelp();
    return;
  }

  const config = await loadConfig(options);
  await validateLocalInputs(config);

  const request = createApiClientForConfig(config);
  const user = await getCurrentUser(request);
  const project = await getProject(request, config);

  console.log(
    `Connected to ${project.path_with_namespace} as ${user.username} (${project.default_branch ?? 'no default branch'})`,
  );

  console.log(`Uploading ${config.filePath}`);
  const upload = await uploadFile(request, config, project);
  console.log(`Upload completed: ${upload.action} ${upload.repositoryFilePath}`);

  const timestamp = createTimestamp();
  console.log('Downloading project archive...');
  const archive = await downloadArchive(request, config, timestamp);
  console.log(`Archive saved: ${archive.archivePath}`);

  const extractionDirectory = path.join(config.extractBase, timestamp);
  console.log(`Extracting to ${extractionDirectory}`);
  const extraction = await extractArchive(
    archive.archivePath,
    config.extractBase,
    timestamp,
  );
  const localUploadedFile = path.join(
    extraction.finalDirectory,
    upload.repositoryFilePath,
  );

  if (!existsSync(localUploadedFile)) {
    throw new Error(`Uploaded file was not found after extraction: ${localUploadedFile}`);
  }

  console.log('');
  console.log('GitLab sync completed');
  console.log(`  GitLab user: ${user.username} (ID ${user.id})`);
  console.log(`  Project: ${project.path_with_namespace} (ID ${project.id})`);
  console.log(`  Branch: ${config.branch}`);
  console.log(`  Upload: ${upload.action} ${upload.repositoryFilePath}`);
  if (upload.commitId) {
    console.log(`  Commit: ${upload.commitId}`);
  }
  console.log(
    `  Archive: ${archive.archivePath} (${archive.archiveSize.toLocaleString()} bytes)`,
  );
  console.log(`  Extracted: ${extraction.finalDirectory}`);
  console.log(`  Verified file: ${localUploadedFile}`);
  console.log(`  Extracted files: ${extraction.extractedFiles.length}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
