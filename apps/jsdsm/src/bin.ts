import { runCli } from './cli.ts';

const controller = new AbortController();
let signalExitCode: number | null = null;
let signalCount = 0;

function handleSignal(exitCode: number): void {
  signalCount += 1;
  if (signalCount > 1) {
    process.exit(exitCode);
  }
  signalExitCode = exitCode;
  controller.abort();
}

process.on('SIGINT', () => handleSignal(130));
process.on('SIGTERM', () => handleSignal(143));

runCli(process.argv.slice(2), undefined, { signal: controller.signal })
  .then((exitCode) => {
    process.exitCode = signalExitCode ?? exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `操作失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = signalExitCode ?? 1;
  });
