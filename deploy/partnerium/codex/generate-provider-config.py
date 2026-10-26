#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys


def generate(container):
    root = Path('/opt/partnerium-crm/codex')
    script = '''
import {readFile} from 'node:fs/promises';
const key=(await readFile('/run/secrets/bridge-token','utf8')).trim();
const response=await fetch('http://127.0.0.1:3001/v1/models',{headers:{authorization:`Bearer ${key}`}});
if(!response.ok)process.exit(1);
console.log(JSON.stringify(await response.json()));
'''
    catalog = json.loads(subprocess.check_output(
        ['docker', 'exec', '-i', container, 'node', '--input-type=module', '-'],
        input=script, text=True,
    ))['data']
    if not catalog:
        raise RuntimeError('Codex returned no models.')
    token = (root / 'bridge-token').read_text().strip()
    provider = {'codex': {
        'npm': '@ai-sdk/openai-compatible',
        'name': 'codex',
        'label': 'Codex · ChatGPT subscription',
        'baseUrl': 'http://partnerium-codex:3001/v1',
        'apiKey': token,
        'models': [{
            'name': model['id'], 'label': model['name'] + ' · Codex',
            'description': 'Uses the server Codex CLI ChatGPT subscription.',
            'inputCostPerMillionTokens': 0, 'outputCostPerMillionTokens': 0,
            'cachedInputCostPerMillionTokens': 0,
            'contextWindowTokens': 64000, 'maxOutputTokens': 8192,
            'modalities': model.get('input_modalities', ['text', 'image']),
        } for model in catalog],
    }}
    default = next((model['id'] for model in catalog if model.get('is_default')), catalog[0]['id'])
    names = {model['id'] for model in catalog}
    fast = 'gpt-6-luna' if 'gpt-6-luna' in names else default
    smart = 'gpt-6-astra' if 'gpt-6-astra' in names else default
    settings = {'AI_PROVIDERS': json.dumps(provider, ensure_ascii=False, separators=(',', ':'))}
    for tier, model in [('EXTRA_FAST', fast), ('FAST', fast), ('BALANCED', default), ('SMART', smart), ('EXTRA_SMART', smart)]:
        settings['AI_MODELS_DEFAULT_' + tier] = json.dumps(['codex/' + model])

    target = root / 'runtime-config.json'
    temporary = root / 'runtime-config.new'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(settings, stream, ensure_ascii=False)
    temporary.replace(target)
    print(f'Prepared {len(catalog)} model configurations in {target}; secrets were not printed.')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: generate-provider-config.py CODEX_CONTAINER_NAME')
    generate(sys.argv[1])
