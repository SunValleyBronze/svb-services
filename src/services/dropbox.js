const aws = require('aws-sdk');
const Bluebird = require('bluebird');
const mime = require('mime-types');
const path = require('path');
const rp = require('request-promise');
const winston = require('winston');

// -[ PRIVATE DATA AND FUNCTIONS ]-----------------------------------------------------------------

// AWS configuration and functions
aws.config.region = 'us-east-1';
aws.config.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
aws.config.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
aws.config.setPromisesDependency(Bluebird);

const s3 = new aws.S3();

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

  winston.info(`transferring from dropbox: ${filePath}`);
  return rp(getOptions)
    .then((response) => {
      const s3Path = toS3Path(filePath);
      const putOptions = {
        ACL: 'public-read',
        Bucket: 'sunvalleybronze.com',
        Key: s3Path,
        Body: new Buffer(response.body),
        ContentDisposition: `inline; filename="${path.basename(filePath)}"`,
        ContentType: mime.lookup(filePath) || 'application/octet-stream',
      };

      winston.info(`transferring to s3: ${s3Path}`);

      return s3.putObject(putOptions).promise();
    })
    .catch((err) => {
      winston.error(`failed to transfer ${filePath}: ${err.message}`);
    });
}

function deleteFromS3(filePaths) {
  
  const delOptions = {
    Bucket: 'sunvalleybronze.com',
    Delete: {
      Objects: filePaths.map(val => ({ Key: val })),
    },
  };

  return s3.deleteObjects(delOptions).promise()
    .then((result) => {
      winston.info(`deleted ${filePaths.length} files with result:`, result);
    })
    .catch((err) => {
      winston.error(`failed to delete ${filePaths.length} files: ${err.message}`);
    });
}

/** Gets the complete tree of Dropbox folders and files so it can be compared to the S3 tree. */
/*
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
      limit: 2000
    },
  };

  return rp(options).then((results) => {
    const tree = results.entries
      .filter(entry => entry['.tag'] === 'file')
      .map(entry => ({
        path: entry.path_lower.slice(1),  // remove leading slash
        modified: new Date(entry.server_modified),
      }))
      .reduce((obj, entry) => Object.assign({}, obj, { [entry.path]: entry }), {});

    winston.info('dropboxTree:', tree);

    return tree;
  });
}
*/
/** START NEW CODE: **/
/** Gets the complete tree of Dropbox folders and files so it can be compared to the S3 tree. */
async function getDropboxTree() {
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
      limit: 2000,
    },
  };

  let allEntries = [];
  let totalCount = 0;

  try {
    let results = await rp(options);
    allEntries = allEntries.concat(results.entries);
    totalCount += results.entries.length;

    // Handle pagination using files/list_folder/continue
    while (results.has_more) {
      const continueOptions = {
        url: 'https://api.dropboxapi.com/2/files/list_folder/continue',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DROPBOX_TOKEN}`,
          'Content-Type': 'application/json',
        },
        json: true,
        body: {
          cursor: results.cursor
        },
      };

      results = await rp(continueOptions);
      allEntries = allEntries.concat(results.entries);
      totalCount += results.entries.length;
    }

    // Log total count of Dropbox items
    winston.info(`Total Dropbox items retrieved: ${totalCount}`);

    // Process entries into a structured tree
    const tree = allEntries
      .filter(entry => entry['.tag'] === 'file')
      .map(entry => ({
        path: entry.path_lower.slice(1), // remove leading slash
        modified: new Date(entry.server_modified),
      }))
      .reduce((obj, entry) => Object.assign({}, obj, { [entry.path]: entry }), {});

    return tree;
  } catch (err) {
    winston.error(`Failed to fetch Dropbox files: ${err.message}`);
    throw err;
  }
}
/** END NEW CODE **/

/** Gets the complete tree of S3 folders and files so it can be compared to the Dropbox tree. */
function getS3Tree() {
  return new Bluebird((resolve, reject) => {
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
          (obj, entry) => Object.assign({}, obj, { [entry.path]: entry }),
          {});

        winston.info('s3Tree:', tree);

        resolve(tree);
      }
    });
  });
}

/** Generates the sitemap.xml document for the tree returned by getS3Tree(). */
function generateS3Sitemap(tree) {
  const nodes = Object.keys(tree).reduce((acc, key) => (`${acc}<url><loc>https://s3.amazonaws.com/sunvalleybronze.com/${encodeURIComponent(key)}</loc></url>`), '');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${nodes}</urlset>`;
}

/** Uploads the sitemap.xml to the S3 site. */
function uploadSitemapToS3(sitemap) {
  const putOptions = {
    ACL: 'public-read',
    Bucket: 'sunvalleybronze.com',
    Key: 'sitemap.xml',
    Body: sitemap,
    ContentType: 'text/xml',
  };

  winston.info('uploading sitemap.xml to S3');

  return s3.putObject(putOptions).promise();
}

/**
 * Determines which files need to be transfererred or deleted from Dropbox to S3.
 *
 * @param trees - array containing the Dropbox and S3 trees
 */
/*** START ORIG CODE 
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

  const protectedFiles = ['sitemap.xml', 'robots.txt', 'index.html'];
  Object.keys(s3Tree).forEach((key) => {
    if (key[key.length - 1] !== '/' && !dropboxTree[key]) {
      winston.debug(`${key} is not a folder and is not in dropbox...`);
      if (protectedFiles.every(val => key.indexOf(val) === -1)) {
        winston.debug('...and is not a protected file: DELETING');
        deleted.push(key);
      }
    }
  });

  const delta = { added, changed, deleted };
  winston.info('delta:', delta);

  // Queue up the transfers for new files
  const promises = [];
  added.forEach((entry) => {
    promises.push(transferFromDropboxToS3(entry));
  });

  // Queue up the transfers for modified files
  changed.forEach((entry) => {
    promises.push(transferFromDropboxToS3(entry));
  });

  // Queue up the deletions
  if (deleted.length) {
    promises.push(deleteFromS3(deleted));
  }

  return Bluebird.all(promises);
}
END ORIG CODE ***/
function synchronizeTrees(trees) {
  const dropboxTree = trees[0];
  const s3Tree = trees[1];

  const added = [];
  const changed = [];
  const deleted = [];

  // Track missing files for debugging
  let missingFiles = [];

  Object.keys(dropboxTree).forEach((key) => {
    if (!s3Tree[key]) {
      added.push(dropboxTree[key].path);
    } else if (dropboxTree[key].modified > s3Tree[key].modified) {
      changed.push(dropboxTree[key].path);
    }
  });

  // Track files to be deleted, but verify first
  const protectedFiles = ['sitemap.xml', 'robots.txt', 'index.html'];
  Object.keys(s3Tree).forEach((key) => {
    if (!dropboxTree[key] && key[key.length - 1] !== '/') {
      if (protectedFiles.every(val => key.indexOf(val) === -1)) {
        winston.debug(`${key} is missing in Dropbox – marking for deletion`);
        deleted.push(key);
      }
    }
  });

  // 🛑 Verify before deleting
  missingFiles = deleted.filter(file => !added.includes(file));
  if (missingFiles.length > 0) {
    winston.warn(`🚨 Potential sync issue: ${missingFiles.length} files are missing but not in Dropbox’s list.`);
    winston.debug(`Missing files: ${JSON.stringify(missingFiles, null, 2)}`);
    deleted.length = 0; // Prevent deletion until verified
  }

  // Log the sync delta
  winston.info(`Dropbox->S3 Sync: ${added.length} added, ${changed.length} changed, ${deleted.length} deleted`);

  // Execute transfers and deletions
  const promises = [];
  added.forEach((entry) => promises.push(transferFromDropboxToS3(entry)));
  changed.forEach((entry) => promises.push(transferFromDropboxToS3(entry)));

  // Only delete if no sync issues detected
  if (deleted.length) {
    promises.push(deleteFromS3(deleted));
  }

  return Bluebird.all(promises);
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
      limit: 2000
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
      ResponseContentDisposition: `attachment; filename="${path.basename(filePath)}"`,
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
      limit: 2000,
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
  Bluebird.all([getDropboxTree(), getS3Tree()])
    .then(synchronizeTrees)
    .then((result) => {
      const message = 'synchronization succeeded';
      winston.info(message, result);
      reply(null, { message });
    })
    .catch((err) => {
      const message = 'synchronization failed';
      winston.error(message, err);
      reply({ message });
    });
}

/**
 * Updates the sitemap.xml file on S3 to ensure it reflects available files.
 *
 * @param reply - asynchronous response function
 */
function updateS3Sitemap(reply) {
  getS3Tree()
    .then(generateS3Sitemap)
    .then(uploadSitemapToS3)
    .then((result) => {
      reply(null, result);
    })
    .catch((err) => {
      const message = 'failed to update sitemap:';
      winston.error(message, err);
      reply({ message, error: err });
    });
}

module.exports = {
  getFileLink,
  getRecentUpdates,
  listFiles,
  synchorizeDropboxToS3,
  updateS3Sitemap,
};
