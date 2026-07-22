import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		// The integration suite builds real git repositories (worktrees, extra
		// remotes, backdated commits); each git call is a process spawn, which is
		// slow on Windows. The mocked suites are unaffected by a higher ceiling.
		timeout: 120000,
	},
});
