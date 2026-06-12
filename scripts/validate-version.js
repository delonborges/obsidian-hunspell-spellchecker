const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

const packageJsonPath = path.join(__dirname, '../package.json');
const manifestJsonPath = path.join(__dirname, '../manifest.json');
const changelogPath = path.join(__dirname, '../CHANGELOG.md');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const manifestJson = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
const changelog = fs.readFileSync(changelogPath, 'utf8');

const packageVersion = packageJson.version;
const manifestVersion = manifestJson.version;

const changelogMatch = changelog.match(/## \[([^\]]+)]/);
const changelogVersion = changelogMatch ? changelogMatch[1] : null;

if (!changelogVersion) {
    console.error("Error: Could not find a version in CHANGELOG.md.");
    process.exit(1);
}

if (packageVersion !== manifestVersion || packageVersion !== changelogVersion) {
    console.error(`\x1b[31mError: Versions are not consistent!\x1b[0m`);
    console.error(`  package.json: ${packageVersion}`);
    console.error(`  manifest.json: ${manifestVersion}`);
    console.error(`  CHANGELOG.md:  ${changelogVersion}`);
    process.exit(1);
}

let isAmend = false;
if (process.env.GIT_REFLOG_ACTION && process.env.GIT_REFLOG_ACTION.includes('amend')) {
    isAmend = true;
} else {
    try {
        const psOutput = execSync('ps -e -o pid,ppid,command').toString();
        const lines = psOutput.split('\n');
        const processMap = {};
        for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
            if (match) {
                processMap[match[1]] = {ppid: match[2], command: match[3]};
            }
        }

        let currentPid = process.pid.toString();
        let p = processMap[currentPid];
        let depth = 0;

        while (p && p.ppid !== '0' && p.ppid !== '1' && depth < 10) {
            if (p.command.includes('git') && p.command.includes('commit') && p.command.includes('--amend')) {
                isAmend = true;
                break;
            }
            currentPid = p.ppid;
            p = processMap[currentPid];
            depth++;
        }
    } catch (e) {
    }
}

if (isAmend) {
    console.log("\x1b[34mℹ Amend commit detected. Skipping version bump validation.\x1b[0m");
    process.exit(0);
}

try {
    const stagedFiles = execSync('git diff --staged --name-only').toString().trim();

    if (stagedFiles) {
        let headPackageVersion = null;
        try {
            const headPackageJsonStr = execSync('git show HEAD:package.json', {stdio: ['pipe', 'pipe', 'ignore']}).toString();
            const headPackageJson = JSON.parse(headPackageJsonStr);
            headPackageVersion = headPackageJson.version;
        } catch (e) {
        }

        if (headPackageVersion && headPackageVersion === packageVersion) {
            console.error("\x1b[31mError: You have staged files, but the project version has not been incremented.\x1b[0m");
            console.error(`The version in the previous commit is \x1b[33m${headPackageVersion}\x1b[0m.`);
            console.error("Please update the versions in package.json, manifest.json, and add a new entry to CHANGELOG.md before committing.");
            process.exit(1);
        }
    }
} catch (e) {
    console.error("Error executing git validation:", e.message);
    process.exit(1);
}

console.log("\x1b[32m✔ Version validation successful.\x1b[0m");
