const serverless = require('serverless-http');
const { connectLambda } = require('@netlify/blobs');
const app = require('../../server');

const handle = serverless(app, {
  binary: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
});

exports.handler = async (event, context) => {
  if (event && event.blobs) connectLambda(event);
  const rewrite = (value) => {
    if (typeof value !== 'string') return value;
    return value.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api');
  };
  event.path = rewrite(event.path);
  event.rawPath = rewrite(event.rawPath);
  return handle(event, context);
};
