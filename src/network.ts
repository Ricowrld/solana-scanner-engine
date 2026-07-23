import https from 'node:https';

export const httpsAgent = new https.Agent({
  keepAlive: true
});
