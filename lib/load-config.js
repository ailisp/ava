import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

import {isPlainObject} from 'is-plain-object';
import {packageConfig, packageJsonPath} from 'pkg-conf';

const NO_SUCH_FILE = Symbol('no ava.config.js file');
const MISSING_DEFAULT_EXPORT = Symbol('missing default export');
const EXPERIMENTS = new Set();

const importConfig = async ({configFile, fileForErrorMessage}) => {
	const {default: config = MISSING_DEFAULT_EXPORT} = await import(url.pathToFileURL(configFile)); // eslint-disable-line node/no-unsupported-features/es-syntax
	if (config === MISSING_DEFAULT_EXPORT) {
		throw new Error(`${fileForErrorMessage} must have a default export`);
	}

	return config;
};

const loadConfigFile = async ({projectDir, configFile}) => {
	if (!fs.existsSync(configFile)) {
		return null;
	}

	const fileForErrorMessage = path.relative(projectDir, configFile);
	try {
		return {config: await importConfig({configFile, fileForErrorMessage}), configFile, fileForErrorMessage};
	} catch (error) {
		throw Object.assign(new Error(`Error loading ${fileForErrorMessage}: ${error.message}`), {parent: error});
	}
};

function resolveConfigFile(configFile) {
	if (configFile) {
		configFile = path.resolve(configFile); // Relative to CWD

		if (!configFile.endsWith('.js') && !configFile.endsWith('.cjs') && !configFile.endsWith('.mjs')) {
			throw new Error('Config files must have .js, .cjs or .mjs extensions');
		}
	}

	return configFile;
}

const gitScmFile = process.env.AVA_FAKE_SCM_ROOT || '.git';

async function findRepoRoot(fromDir) {
	const {root} = path.parse(fromDir);
	let dir = fromDir;
	while (root !== dir) {
		try {
			const stat = await fs.promises.stat(path.join(dir, gitScmFile)); // eslint-disable-line no-await-in-loop
			if (stat.isFile() || stat.isDirectory()) {
				return dir;
			}
		} catch {}

		dir = path.dirname(dir);
	}

	return root;
}

export async function loadConfig({configFile, resolveFrom = process.cwd(), defaults = {}} = {}) {
	let packageConf = await packageConfig('ava', {cwd: resolveFrom});
	const filepath = packageJsonPath(packageConf);
	const projectDir = filepath === undefined ? resolveFrom : path.dirname(filepath);

	const repoRoot = await findRepoRoot(projectDir);

	// Conflicts are only allowed when an explicit config file is provided.
	const allowConflictWithPackageJson = Boolean(configFile);
	configFile = resolveConfigFile(configFile);

	let fileConf = NO_SUCH_FILE;
	let fileForErrorMessage;
	let conflicting = [];
	if (configFile) {
		const loaded = await loadConfigFile({projectDir, configFile});
		if (loaded !== null) {
			({config: fileConf, fileForErrorMessage} = loaded);
		}
	} else {
		let searchDir = projectDir;
		const stopAt = path.dirname(repoRoot);
		do {
			const results = await Promise.all([ // eslint-disable-line no-await-in-loop
				loadConfigFile({projectDir, configFile: path.join(searchDir, 'ava.config.js')}),
				loadConfigFile({projectDir, configFile: path.join(searchDir, 'ava.config.cjs')}),
				loadConfigFile({projectDir, configFile: path.join(searchDir, 'ava.config.mjs')}),
			]);

			[{config: fileConf, fileForErrorMessage, configFile} = {config: NO_SUCH_FILE, fileForErrorMessage: undefined}, ...conflicting] = results.filter(result => result !== null);

			searchDir = path.dirname(searchDir);
		} while (fileConf === NO_SUCH_FILE && searchDir !== stopAt);
	}

	if (conflicting.length > 0) {
		throw new Error(`Conflicting configuration in ${fileForErrorMessage} and ${conflicting.map(({fileForErrorMessage}) => fileForErrorMessage).join(' & ')}`);
	}

	if (fileConf !== NO_SUCH_FILE) {
		if (allowConflictWithPackageJson) {
			packageConf = {};
		} else if (Object.keys(packageConf).length > 0) {
			throw new Error(`Conflicting configuration in ${fileForErrorMessage} and package.json`);
		}

		if (!isPlainObject(fileConf) && typeof fileConf !== 'function') {
			throw new TypeError(`${fileForErrorMessage} must export a plain object or factory function`);
		}

		if (typeof fileConf === 'function') {
			fileConf = await fileConf({projectDir});

			if (!isPlainObject(fileConf)) {
				throw new TypeError(`Factory method exported by ${fileForErrorMessage} must return a plain object`);
			}
		}

		if ('ava' in fileConf) {
			throw new Error(`Encountered ’ava’ property in ${fileForErrorMessage}; avoid wrapping the configuration`);
		}
	}

	const config = {...defaults, nonSemVerExperiments: {}, ...fileConf, ...packageConf, projectDir, configFile};

	const {nonSemVerExperiments: experiments} = config;
	if (!isPlainObject(experiments)) {
		throw new Error(`nonSemVerExperiments from ${fileForErrorMessage} must be an object`);
	}

	for (const key of Object.keys(experiments)) {
		if (!EXPERIMENTS.has(key)) {
			throw new Error(`nonSemVerExperiments.${key} from ${fileForErrorMessage} is not a supported experiment`);
		}
	}

	return config;
}
