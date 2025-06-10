const path = require('path');

module.exports = {
  reactStrictMode: true,
  webpack(config: { resolve: { alias: { [x: string]: any; }; }; }) {
    config.resolve.alias['@'] = path.resolve(__dirname, 'src');
    return config;
  }
};
