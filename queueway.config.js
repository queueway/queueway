module.exports = {
  broker: 'rabbitmq',
  store: 'postgres',
  retry: {
    maxAttempts: 5,
    strategy: 'exponential',
  },
};
