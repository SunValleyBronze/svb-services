const bodyParser = require('body-parser');
const express = require('express');
const services = require('./services');
const winston = require('winston');

winston.level = process.env.LOG_LEVEL;

// -[ INITIALIZE SERVER ]--------------------------------------------------------------------------
const server = express();

server.use(bodyParser.urlencoded({ extended: true }));
server.use(bodyParser.json());

// CORS
server.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// -[ INITIALIZE ROUTES ]--------------------------------------------------------------------------

/**
 * Uses Express's response function to implement the (more generic) reply function used by
 * this application's services.
 *
 * @param res - Express response function
 *
 * @returns a reply(err, result) function
 */
function reply(res) {
  return (err, result) => {
    if (err) {
      res.send(err);
    } else {
      res.json(result);
    }
  };
}

const router = express.Router();

router.get('/ping', (req, res) => {
  res.json({ message: 'pong' });
});

router.get('/dropbox/list', (req, res) => {
  const folderPath = req.query.path || req.query.folder;

  services.dropbox.listFiles(folderPath, reply(res));
});

router.get('/dropbox/recentUpdates', (req, res) => {
  const folderPath = req.query.path || req.query.folder;
  const count = req.query.count || 0;

  services.dropbox.getRecentUpdates(folderPath, count, reply(res));
});

router.get('/dropbox/getFileLink', (req, res) => {
  const filePath = req.query.path || req.query.file;

  services.dropbox.getFileLink(filePath, reply(res));
});

router.get('/dropbox/synchronizeDropboxToS3', (req, res) => {
  services.dropbox.synchorizeDropboxToS3(reply(res));
});

server.use(router);

// -[ START THE SERVER ]---------------------------------------------------------------------------

const port = process.env.PORT || 8080;

server.listen(port);
winston.info(`Listening on port ${port}`);
