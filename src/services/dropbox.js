const aws = require('aws-sdk');
const Promise = require('bluebird');
const mime = require('mime-types');
const path = require('path');
const rp = require('request-promise');
const winston = require('winston');

// -[ PRIVATE DATA AND FUNCTIONS ]-----------------------------------------------------------------

// AWS configuration and functions
aws.config.region = 'us-east-1';
const s3 = new aws.S3();
const putObject = Promise.promisify(s3.putObject);
const deleteObject = Promise.promisify(s3.deleteObject);

/** Converts a path to one AWS S3 expects. */
function toS3Path(anyPath) {
  return (anyPath && anyPath[0] === '/') ? anyPath.slice(1) : anyPath;
}

/** Converts a path to one Dropbox expects. */
function toDropboxPath(anyPath) {
  return (anyPath && anyPath[0] !== '/') ? `/${anyPath}` : anyPath;
}

/** Comparer for alphabetizing paths in Dropbox entries. */
function comparePath(entryA, entryB) {
  return entryA.path.localeCompare(entryB.path);
}

/** Comparer for sorting by reverse date order in Dropbox modified dates. */
function compareModified(entryA, entryB) {
  const da = new Date(entryA.modified);
  const db = new Date(entryB.modified);

  return (da < db) - (da > db);
}

/**
 * Transfers a file from Dropbox to S3.
 *
 * @param filePath - path to the Dropbox file
 */
function transferFromDropboxToS3(filePath) {
  const getOptions = {
    url: 'https://content.dropboxapi.com/2/files/download',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
      'Dropbox-API-Arg': JSON.stringify({ path: toDropboxPath(filePath) }),
    },
    gzip: true,
    encoding: null,
    resolveWithFullResponse: true,
  };

  winston.info(`downloading from dropbox: ${filePath}`);
  return rp(getOptions)
    .then((response) => {
      const s3Path = toS3Path(filePath);
      const putOptions = {
        ACL: 'public-read',
        Bucket: 'sunvalleybronze.com',
        Key: s3Path,
        Body: new Buffer(response.body),
        ContentDisposition: `inline; filename="${path.basename(event.path)}"`,
        ContentType: mime.lookup(event.path) || 'application/octet-stream',
      };

      winston.info(`uploading to s3: ${s3Path}`);
      return putObject(putOptions);
    })
    .catch((err) => {
      winston.error(`failed to upload: ${err.message}`);
    });
}

function deleteFromS3(filePath) {
  const s3Path = toS3Path(filePath);
  const delOptions = {
    Bucket: 'sunvalleybronze.com',
    Key: s3Path,
  };

  winston.info(`uploading to s3: ${s3Path}`);
  return deleteObject(delOptions)
    .catch((err) => {
      winston.error(`failed to delete ${s3Path}: ${err.message}`);
    });
}

/** Gets the complete tree of Dropbox folders and files so it can be compared to the S3 tree. */
function getDropboxTree() {
  const options = {
    url: 'https://api.dropboxapi.com/2/files/list_folder',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
      'Content-Type': 'application/json',
    },
    json: true,
    body: {
      path: '',
      recursive: true,
    },
  };

  return rp(options).then((results) => {
    const tree = results.entries
    .filter(entry => entry['.tag'] === 'file')
    .map(entry => ({
      path: entry.path_lower.slice(1),  // remove leading slash
      modified: new Date(entry.server_modified),
    }))
    .reduce((obj, entry) => Object.assign({}, obj, { path: entry }), {});

    winston.info('dropboxTree:', tree);

    return tree;
  });
}

/** Gets the complete tree of S3 folders and files so it can be compared to the Dropbox tree. */
function getS3Tree() {
  return new Promise((resolve, reject) => {
    const params = {
      Bucket: 'sunvalleybronze.com',
    };
    s3.listObjectsV2(params, (err, data) => {
      if (err) {
        reject(err);
      } else {
        const tree = data.Contents
        .map(entry => ({
          path: entry.Key.toLowerCase(),
          modified: entry.LastModified,
        }))
        .sort(comparePath)
        .reduce(
          (obj, entry) => Object.assign({}, obj, { path: entry }),
          {});

        winston.info('s3Tree:', tree);

        resolve(tree);
      }
    });
  });
}

/**
 * Determines which files need to be transfererred or deleted from Dropbox to S3.
 *
 * @param trees - array containing the Dropbox and S3 trees
 */
function synchronizeTrees(trees) {
  const dropboxTree = trees[0];
  const s3Tree = trees[1];

  const added = [];
  const changed = [];
  const deleted = [];

  Object.keys(dropboxTree).forEach((key) => {
    if (!s3Tree[key]) {
      added.push(dropboxTree[key].path);
    } else if (dropboxTree[key].modified > s3Tree[key].modified) {
      changed.push(dropboxTree[key].path);
    }
  });

  Object.keys(s3Tree).forEach((key) => {
    if (s3Tree[key][key.length - 1] !== '/' && !dropboxTree[key]) {
      deleted.push(s3Tree[key].path);
    }
  });

  const delta = { added, changed, deleted };
  winston.info('delta:', delta);

  const promises = [];
  added.forEach((entry) => {
    winston.info(`uploading new file: ${entry}`);
    promises.push(transferFromDropboxToS3(entry));
  });

  changed.forEach((entry) => {
    winston.info(`uploading modified file: ${entry}`);
    promises.push(transferFromDropboxToS3(entry));
  });

  deleted.forEach((entry) => {
    winston.info(`deleting file: ${entry}`);
    promises.push(deleteFromS3(entry));
  });

  return Promise.all(promises);
}

/**
 * Converts the entries returned by the Dropbox list_folder API to a tree of folders and files.
 * This is an important function because it determines the structure of the file entries
 * processed and displayed for site visitors.
 *
 * entries - array of Dropbox entries
 * sortOrder - 'path' or 'modified'
 * count - optional number of entries to return
 */
function formatDropboxEntries(entries, sortOrder, count) {
  const sorter = sortOrder.toLowerCase() === 'path' ? comparePath : compareModified;

  return entries
    .filter(entry => entry['.tag'] === 'file')
    .map(entry => ({
      id: entry.id,
      name: path.basename(entry.path_display, path.extname(entry.path_display)),
      type: path.extname(entry.path_display).toUpperCase(),
      path: `https://s3.amazonaws.com/sunvalleybronze.com${entry.path_lower}`,
      modified: entry.server_modified,
    }))
    .sort(sorter)
    .slice(0, count || undefined);
}

// -[ PUBLIC FUNCTIONS ]---------------------------------------------------------------------------

/**
 * Returns a list of files in a Dropbox folder.
 *
 * @param folderPath - path to the dropbox folder
 * @param reply - asynchronous response function
 *
 * Returns an array of file entries whose format is defined above in formatDropboxEntries().
 */
function listFiles(folderPath, reply) {
  // Configure the call to Dropbox
  const options = {
    url: 'https://api.dropboxapi.com/2/files/list_folder',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
      'Content-Type': 'application/json',
    },
    json: true,
    body: {
      path: toDropboxPath(folderPath),
      recursive: false,
    },
  };

  // Call Dropbox and format the results
  rp(options)
    .then((results) => {
      reply(null, formatDropboxEntries(results.entries, 'path'));
    })
    .catch((err) => {
      reply(err);
    });
}

/**
 * Gets a link to a Dropbox file's "shadow" on AWS S3.
 *
 * @param filePath - path to the dropbox file
 * @param reply - asynchronous response function
 */
function getFileLink(filePath, reply) {
  if (filePath) {
    const s3Path = toS3Path(filePath.toLowerCase());
    const url = `https://s3.amazonaws.com/sunvalleybronze.com/${s3Path}`;
    const params = {
      Bucket: 'sunvalleybronze.com',
      Key: s3Path,
      ResponseContentDisposition: `attachment; filename="${path.basename(event.path)}"`,
    };
    s3.getSignedUrl('getObject', params, (err, signedUrl) => {
      reply(null, {
        link: url,
        downloadLink: signedUrl,
      });
    });
  } else {
    reply('The path parameter is required.');
  }
}

/**
 * Gets recent updates to files in a Dropbox folder.
 *
 * @param folderPath - path to a Dropbox folder
 * @param count - optional number of entries to return
 * @param reply - asynchronous response function
 */
function getRecentUpdates(folderPath, count, reply) {
  const options = {
    url: 'https://api.dropboxapi.com/2/files/list_folder',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
      'Content-Type': 'application/json',
    },
    json: true,
    body: {
      path: folderPath,
      recursive: true,
    },
  };

  rp(options)
    .then((results) => {
      reply(null, formatDropboxEntries(results.entries, 'modified', count));
    })
    .catch((err) => {
      reply(err);
    });
}

/**
* Synchronizes the target storage (S3) with the source storage (Dropbox) tree.
*
* @param reply - asynchronous response function
*/
function synchorizeDropboxToS3(reply) {
  Promise.all([getDropboxTree(), getS3Tree()])
  .then(synchronizeTrees)
  .then((result) => {
    reply(null, result);
  })
  .catch((err) => {
    reply(err);
  });
}

module.exports = {
  getFileLink,
  getRecentUpdates,
  listFiles,
  synchorizeDropboxToS3,
};
