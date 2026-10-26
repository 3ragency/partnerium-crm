import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args.includes('login')) {
  process.stderr.write('Logged in using ChatGPT\n');
} else if (args.includes('models')) {
  send({
    models: [
      'test-model',
      'tool-model',
      'failed-model',
      'slow-model',
      'limited-model',
    ].map((slug, priority) => ({
      slug,
      display_name: slug,
      visibility: 'list',
      priority,
    })),
  });
} else {
  let input = '';

  for await (const chunk of process.stdin) input += chunk;
  const messages = JSON.parse(input.slice(input.indexOf('\n') + 1));
  const model = args[args.indexOf('--model') + 1];
  const output = args[args.indexOf('--output-last-message') + 1];

  if (
    !args.includes('default_permissions="crm"') ||
    !args.includes('features.shell_tool=false')
  )
    process.exit(3);
  if (model === 'slow-model') {
    setInterval(() => {}, 10000);
  } else if (model === 'failed-model' || model === 'limited-model') {
    send({
      type: 'turn.failed',
      error: {
        message:
          model === 'limited-model'
            ? 'Usage limit reached'
            : 'Private upstream details',
      },
    });
    process.exitCode = 1;
  } else {
    let answer = 'Hello';

    if (args.includes('--output-schema')) {
      const schema = JSON.parse(
        await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'),
      );
      const callName =
        model === 'tool-model' &&
        !messages.some((message) => message.role === 'tool')
          ? 'find_contact'
          : undefined;

      answer = schema.properties?.tool_calls
        ? JSON.stringify({
            content: callName ? '' : 'Hello',
            tool_calls: callName
              ? [{ name: callName, arguments: '{"name":"Alice"}' }]
              : [],
          })
        : '{"title":"Hello"}';
    }
    await writeFile(output, answer);
    send({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  }
}
