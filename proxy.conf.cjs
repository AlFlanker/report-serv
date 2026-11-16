module.exports = {
  '/api/**': {
    target: `http://127.0.0.1:${process.env.API_PORT || process.env.PORT || '3001'}`,
  },
};
