const dropbox = require('./dropbox');
const seneca = require('seneca')();
const winston = require('winston');

winston.level = process.env.LOG_LEVEL;

// -[ SENECA SERVICES: DROPBOX ]-------------------------------------------------------------------

winston.info('Registering Dropbox services...');

seneca
  .add('role:dropbox,cmd:getFileLink', (msg, reply) => {
    dropbox.getFileLink(msg.path, reply);
  })
  .add('role:dropbox,cmd:getRecentUpdates', (msg, reply) => {
    dropbox.getRecentUpdates(msg.path, msg.count, reply);
  })
  .add('role:dropbox,cmd:listFiles', (msg, reply) => {
    dropbox.listFiles(msg.path || msg.folder, reply);
  })
  .add('role:dropbox,cmd:synchronizeDropboxToS3', (msg, reply) => {
    dropbox.synchorizeDropboxToS3(reply);
  });

winston.info(seneca.list('role:dropbox').map(x => x.cmd));
