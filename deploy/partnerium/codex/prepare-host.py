#!/usr/bin/env python3
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def prepare():
    root = Path('/opt/partnerium-crm/codex')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    (root / 'bin').mkdir(exist_ok=True)
    auth = root / 'auth'
    auth.mkdir(mode=0o700, exist_ok=True)
    os.chown(auth, 1000, 1000)

    binary = Path('/root/.local/bin/codex').resolve(strict=True)
    version = subprocess.check_output([str(binary), '--version'], text=True).strip()
    if version != 'codex-cli 0.164.0':
        raise RuntimeError('This bridge is verified against Codex CLI 0.164.0; validate the protocol before changing it.')
    candidate = root / 'bin/codex.new'
    shutil.copyfile(binary, candidate)
    candidate.chmod(0o755)
    candidate.replace(root / 'bin/codex')

    credentials = auth / 'auth.json'
    if not credentials.exists():
        source = Path('/root/.codex/auth.json')
        if not source.is_file():
            raise RuntimeError('Run Codex CLI device login first; no file-based login was found.')
        with source.open() as stream:
            if json.load(stream).get('auth_mode') != 'chatgpt':
                raise RuntimeError('A ChatGPT login is required.')
        with open(credentials, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            stream.write(source.read_text())
        os.chown(credentials, 1000, 1000)

    config = auth / 'config.toml'
    if not config.exists():
        config.write_text('cli_auth_credentials_store = "file"\nweb_search = "disabled"\n[history]\npersistence = "none"\n')
        config.chmod(0o600)
        os.chown(config, 1000, 1000)

    token = root / 'bridge-token'
    if not token.exists():
        with open(token, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            stream.write(secrets.token_urlsafe(48) + '\n')
        os.chown(token, 1000, 1000)

    print('Codex bridge host files prepared; credentials and bridge key were not printed.')


if __name__ == '__main__':
    prepare()
