import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  public readonly args: string[];
  public readonly cwd: string;

  constructor(message: string, args: string[], cwd: string) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
  }
}

export async function runGit(cwd: string, args: string[]): Promise<{ stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    return { stdout: stdout.toString() };
  } catch (err: any) {
    const msg = err?.message ? String(err.message) : String(err);
    // Keep message compact but actionable
    throw new GitError(`git ${args.join(' ')} failed: ${msg}`, args, cwd);
  }
}
