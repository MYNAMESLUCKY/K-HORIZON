const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: './src/extension.ts',
  target: 'node',
  mode: 'none',
  resolve: {
    extensions: ['.ts', '.js']
  },
  // Suppress the optional `pg-native` native binding; `pg` falls back to
  // the pure-JS driver automatically. Eliminates the webpack "Can't resolve
  // 'pg-native'" warning at build time.
  ignoreWarnings: [
    { module: /node_modules\/pg\/lib\/native/ }
  ],
  plugins: [
    new webpack.IgnorePlugin({
      resourceRegExp: /^pg-native$/
    })
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true
            }
          }
        ]
      }
    ]
  },
  output: {
    filename: 'extension.js',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'commonjs'
  },
  externals: {
    vscode: 'commonjs vscode',
    'playwright-core': 'commonjs playwright-core',
    typescript: 'commonjs typescript',
    '@langchain/core': 'commonjs @langchain/core',
    '@langchain/langgraph': 'commonjs @langchain/langgraph',
    'cheerio': 'commonjs cheerio',
    'pg': 'commonjs pg'
  },
  devtool: 'source-map'
};
