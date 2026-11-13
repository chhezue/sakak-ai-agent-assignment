import { startApp } from './app';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be between 1 and 65535');
startApp({ port })
  .then(async (app) => {
    app.enableShutdownHooks();
    console.log('Health Checkup AI Assistant ' + (await app.getUrl()));
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
