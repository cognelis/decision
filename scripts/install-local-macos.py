"""Replace /Applications/Paraself.app with the freshly packaged build.

Same procedure the repository has used for every local install:
stage a copy next to the target, verify its signature and archive hash,
quit only the GUI instance (bridge processes keep running from the old
inode), swap the bundles atomically, relaunch, wait for a healthy runtime,
and roll back automatically if anything fails. After a healthy launch,
remove the previous bundle and the temporary staging directory.

The App as it was named before, /Applications/Decision.app, is quit before
the new one starts (that start renames its data folder, which must not be in
use), and removed with the previous bundle once the new one is healthy. A
failed install leaves it where it was.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import secrets
import shutil
import signal
import subprocess
import time
import urllib.request

source = Path(__file__).resolve().parents[1] / 'out/Paraself-darwin-arm64/Paraself.app'
destination = Path('/Applications/Paraself.app')
legacy = Path('/Applications/Decision.app')
parser = argparse.ArgumentParser(description='Install the verified local macOS build with health checks and automatic rollback.')
parser.add_argument('--apply', action='store_true', help='Replace and restart the installed GUI after verifying the staged build.')
args = parser.parse_args()
if not args.apply:
    print(json.dumps({'source': str(source), 'destination': str(destination), 'mode': 'dry-run', 'sourceExists': source.exists(), 'legacyToRemove': str(legacy) if legacy.exists() else None}))
    raise SystemExit(0)
update_root = Path(f'/Applications/.Paraself-update-{secrets.token_hex(4)}')
staged = update_root / 'Paraself.app'
previous = update_root / 'previous.app'
# Only the GUI executable; bridge processes run via Resources/bridge/../../MacOS/Paraself.
pattern = r'^/Applications/Paraself\.app/Contents/MacOS/Paraself( |$)'
legacy_pattern = r'^/Applications/Decision\.app/Contents/MacOS/Decision( |$)'


def app_pids(which=pattern):
    result = subprocess.run(['pgrep', '-f', which], capture_output=True, text=True)
    if result.returncode not in (0, 1):
        raise RuntimeError('Unable to inspect the running application')
    return [int(pid) for pid in result.stdout.split()]


def blocked_on_keychain(pid):
    """Whether the main thread is parked inside a synchronous Keychain read.

    safeStorage decryption is synchronous and main-process only, so the first
    credential read after the bundle's signature changes waits on securityd
    for the user to authorise the new binary -- and the thread that would
    paint that dialog is the one waiting. The app then answers neither
    SIGTERM nor an AppleEvent, which on its own reads like a plain hang.
    """
    try:
        sampled = subprocess.run(
            ['sample', str(pid), '1', '-mayDie'],
            capture_output=True, text=True, timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return 'SecItemCopyMatching' in sampled or 'SecKeychainItemCopyContent' in sampled


def stop_app(which=pattern, name='Paraself'):
    for pid in app_pids(which):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 30
    while app_pids(which):
        if time.monotonic() >= deadline:
            stuck = app_pids(which)
            if stuck and blocked_on_keychain(stuck[0]):
                raise RuntimeError(
                    f'{name} is waiting on a macOS keychain authorisation prompt and cannot '
                    'quit until it is answered: the new bundle is signed differently, so the '
                    'stored model credential needs approval again. Answer the dialog (it may '
                    'be behind other windows), then run this script again. Nothing was replaced.'
                )
            raise RuntimeError(f'{name} did not finish its normal shutdown; installation paused')
        time.sleep(0.25)


def archive_hash(app):
    with (app / 'Contents/Resources/app.asar').open('rb') as archive:
        digest = hashlib.sha256()
        for chunk in iter(lambda: archive.read(1024 * 1024), b''):
            digest.update(chunk)
        return digest.hexdigest()


if not source.exists():
    raise SystemExit(f'Packaged build missing: {source}')

try:
    subprocess.run(['ditto', str(source), str(staged)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(staged)], check=True)
    if archive_hash(source) != archive_hash(staged):
        raise RuntimeError('Staged application does not match the verified build')
    print('Verified staged application; closing the installed App.', flush=True)
    stop_app()
    # The App as Decision, quit before the new one renames the data folder it has open.
    stop_app(legacy_pattern, 'Decision')
except Exception:
    # Nothing has moved yet, so the staged copy is 300-odd MB of dead weight
    # sitting in /Applications under a name nobody will recognise later.
    shutil.rmtree(update_root, ignore_errors=True)
    raise
if destination.exists():
    destination.rename(previous)
try:
    staged.rename(destination)
    # LaunchServices can still retain the just-exited GUI registration (-600).
    # Force a fresh launch; the App's own single-instance lock remains in force.
    subprocess.run(['open', '-n', str(destination)], check=True)
    support = Path.home() / 'Library/Application Support'
    # Decision's folder where the App could not rename it: it then runs from there, and says why.
    runtime_files = [support / 'Paraself/runtime.json', support / 'Decision/runtime.json']
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        healthy = False
        for runtime_file in runtime_files:
            try:
                runtime = json.loads(runtime_file.read_text())
                if runtime['pid'] in app_pids():
                    with urllib.request.urlopen(f"http://127.0.0.1:{int(runtime['port'])}/health", timeout=2) as response:
                        healthy = response.status == 200
            except (OSError, ValueError, KeyError):
                pass
            if healthy:
                break
        if healthy:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Updated App did not report a healthy runtime')
except Exception:
    stop_app()
    if destination.exists():
        destination.rename(update_root / 'failed.app')
    if previous.exists():
        previous.rename(destination)
        subprocess.run(['open', '-n', str(destination)], check=True)
    if legacy.exists():
        print(f'{legacy} was quit and left where it is.', flush=True)
    raise

# Healthy: the bundle as Decision goes with the previous one, its GUI quit above. Bridge processes still running
# from it keep their inode until their client restarts them.
removed_legacy = None
if legacy.exists():
    stop_app(legacy_pattern, 'Decision')
    legacy.rename(update_root / 'Decision.app')
    removed_legacy = str(legacy)
shutil.rmtree(update_root)
print(json.dumps({
    'installed': str(destination),
    'healthy': True,
    'archiveSha256': archive_hash(destination),
    'removedLegacy': removed_legacy,
}, ensure_ascii=False), flush=True)
