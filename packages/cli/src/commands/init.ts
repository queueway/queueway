import inquirer from 'inquirer';
import fs from 'fs';

export async function init() {
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'database',
      message: 'Choose database:',
      choices: ['PostgreSQL', 'MongoDB', 'SQLite'],
    },
    {
      type: 'list',
      name: 'broker',
      message: 'Choose broker:',
      choices: ['RabbitMQ', 'Kafka', 'Redis'],
    },
  ]);

  const config = `import { defineConfig } from 'queueway';

export default defineConfig({
  broker: { type: '${answers.broker.toLowerCase()}' },
  store: { type: '${answers.database.toLowerCase()}' },
  retry: {
    maxAttempts: 5,
    strategy: 'exponential',
  },
});
`;

  fs.writeFileSync('queueway.config.ts', config);
  console.log('✅ Config created: queueway.config.ts');
}
