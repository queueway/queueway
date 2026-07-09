import inquirer from 'inquirer';
import fs from 'fs';
import { logger } from '../../logging/Logger';

const STORE_CHOICES = [
  { name: 'SQLite (recommended — persists to disk, survives crashes/restarts)', value: 'sqlite' },
  { name: 'In-Memory (testing only — data lost on restart)', value: 'in-memory' },
];

const BROKER_CHOICES = [
  { name: 'In-Memory (single-process)', value: 'in-memory' },
];

const JOBS_TEMPLATE = `// queueway.jobs.js
// Define your job handlers here. This file is auto-loaded by \`queueway start\`.
module.exports = function registerJobs(queue) {
  // Example:
  // queue.subscribe('email.send', async (job) => {
  //   console.log('Sending email:', job.data);
  // });
};
`;

export async function init() {
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'store',
      message: 'Choose a store (where job records are saved):',
      choices: STORE_CHOICES,
    },
    {
      type: 'list',
      name: 'broker',
      message: 'Choose a broker (how jobs are delivered):',
      choices: BROKER_CHOICES,
    },
  ]);

  const config = `module.exports = {
  broker: '${answers.broker}',
  store: '${answers.store}',
  retry: {
    maxAttempts: 5,
    strategy: 'exponential',
  },
};
`;

  fs.writeFileSync('queueway.config.js', config);
  logger.info('✅ Config created: queueway.config.js');

  if (!fs.existsSync('queueway.jobs.js')) {
    fs.writeFileSync('queueway.jobs.js', JOBS_TEMPLATE);
    logger.info('✅ Starter jobs file created: queueway.jobs.js');
  }

  logger.info('');
  logger.info('Next: run `npx queueway start` to boot the server + dashboard.');
}