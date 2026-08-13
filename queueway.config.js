module.exports = {
  broker: 'redis',
  store: 'postgres',
  retry: {
    maxAttempts: 5,
    strategy: 'exponential',
  },
};
