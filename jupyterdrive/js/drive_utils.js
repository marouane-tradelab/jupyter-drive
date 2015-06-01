// Copyright (c) IPython Development Team.
// Distributed under the terms of the Modified BSD License.
define(["require", "exports", 'jquery', './gapi_utils'], function (require, exports, $, gapi_utils) {
    exports.FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
    exports.NOTEBOOK_MIMETYPE = 'application/ipynb';
    exports.MULTIPART_BOUNDARY = '-------314159265358979323846';
    /** Enum for file types */
    exports.FileType = {
        FILE: 1,
        FOLDER: 2
    };
    /**
     * Obtains the Google Drive Files resource for a file or folder relative
     * to the a given folder.  The path should be a file or a subfolder, and
     * should not contain multiple levels of folders (hence the name
     * path_component).  It should also not contain any leading or trailing
     * slashes.
     *
     * @param {String} path_component The file/folder to find
     * @param {FileType} type type of resource (file or folder)
     * @param {boolean} opt_child_resource If True, fetches a child resource
     *     which is smaller and probably quicker to obtain the a Files resource.
     * @param {String} folder_id The Google Drive folder id
     * @return A promise fullfilled by either the files resource for the given
     *     file/folder, or rejected with an Error object.
     */
    exports.get_resource_for_relative_path = function (path_component, type, opt_child_resource, folder_id) {
        var query = 'title = \'' + path_component + '\' and trashed = false ';
        if (type == exports.FileType.FOLDER) {
            query += ' and mimeType = \'' + exports.FOLDER_MIME_TYPE + '\'';
        }
        var request = null;
        if (opt_child_resource) {
            request = gapi.client.drive.children.list({ 'q': query, 'folderId': folder_id });
        }
        else {
            query += ' and \'' + folder_id + '\' in parents';
            request = gapi.client.drive.files.list({ 'q': query });
        }
        return gapi_utils.gapi_utils.execute(request).then(function (response) {
            var files = response['items'];
            if (!files || files.length == 0) {
                var error = new Error('The specified file/folder did not exist: ' + path_component);
                error.name = 'NotFoundError';
                throw error;
            }
            if (files.length > 1) {
                var error = new Error('Multiple files/folders with the given name existed: ' + path_component);
                error.name = 'BadNameError';
                throw error;
            }
            return files[0];
        });
    };
    /**
     * Split a path into path components
     */
    exports.split_path = function (path) {
        return path.split('/').filter(function (c) {
            return c;
        });
    };
    /**
     * Gets the Google Drive Files resource corresponding to a path.  The path
     * is always treated as an absolute path, no matter whether it contains
     * leading or trailing slashes.  In fact, all leading, trailing and
     * consecutive slashes are ignored.
     *
     * @param {String} path The path
     * @param {FileType} type The type (file or folder)
     * @return {Promise} fullfilled with file/folder id (string) on success
     *     or Error object on error.
     */
    exports.get_resource_for_path = function (path, type) {
        var components = exports.split_path(path);
        if (components.length == 0) {
            return gapi_utils.gapi_utils.execute(gapi.client.drive.about.get()).then(function (resource) {
                var id = resource['rootFolderId'];
                var request = gapi.client.drive.files.get({ 'fileId': id });
                return gapi_utils.gapi_utils.execute(request);
            });
        }
        var result = Promise.resolve({ id: 'root' });
        for (var i = 0; i < components.length; i++) {
            var component = components[i];
            var t = (i == components.length - 1) ? type : exports.FileType.FOLDER;
            var child_resource = i < components.length - 1;
            result = result.then(function (resource) {
                return resource['id'];
            });
            result = result.then($.proxy(exports.get_resource_for_relative_path, this, component, t, child_resource));
        }
        ;
        return result;
    };
    /**
     * Gets the Google Drive file/folder ID for a file or folder.  The path is
     * always treated as an absolute path, no matter whether it contains leading
     * or trailing slashes.  In fact, all leading, trailing and consecutive
     * slashes are ignored.
     *
     * @param {String} path The path
     * @param {FileType} type The type (file or folder)
     * @return {Promise} fullfilled with folder id (string) on success
     *     or Error object on error.
     */
    exports.get_id_for_path = function (path, type) {
        var components = exports.split_path(path);
        if (components.length == 0) {
            return $.Deferred().resolve('root');
        }
        return exports.get_resource_for_path(path, type).then(function (resource) {
            return resource['id'];
        });
    };
    /**
     * Obtains the filename that should be used for a new file in a given
     * folder.  This is the next file in the series Untitled0, Untitled1, ... in
     * the given drive folder.  As a fallback, returns Untitled.
     *
     * @method get_new_filename
     * @param {function(string)} callback Called with the name for the new file.
     * @param {string} opt_folderId optinal Drive folder Id to search for
     *     filenames.  Uses root, if none is specified.
     * @param {string} ext The extension to use
     * @param {string} base_name The base name of the file
     * @return A promise fullfilled with the new filename.  In case of errors,
     *     'Untitled.ipynb' is used as a fallback.
     */
    exports.get_new_filename = function (opt_folderId, ext, base_name) {
        /** @type {string} */
        var folderId = opt_folderId || 'root';
        var query = 'title contains \'' + base_name + '\'' + ' and \'' + folderId + '\' in parents' + ' and trashed = false';
        var request = gapi.client.drive.files.list({
            'maxResults': 1000,
            'folderId': folderId,
            'q': query
        });
        var fallbackFilename = base_name + ext;
        return gapi_utils.gapi_utils.execute(request).then(function (response) {
            // Use 'Untitled.ipynb' as a fallback in case of error
            var files = response['items'] || [];
            var existingFilenames = $.map(files, function (filesResource) {
                return filesResource['title'];
            });
            for (var i = 0; i <= existingFilenames.length; i++) {
                /** @type {string} */
                var filename = base_name + i + ext;
                if (existingFilenames.indexOf(filename) == -1) {
                    return filename;
                }
            }
            // Control should not reach this point, so an error has occured
            return fallbackFilename;
        }).catch(function (error) {
            return Promise.resolve(fallbackFilename);
        });
    };
    /**
     * Uploads a notebook to Drive, either creating a new one or saving an
     * existing one.
     *
     * @method upload_to_drive
     * @param {string} data The file contents as a string
     * @param {Object} metadata File metadata
     * @param {string=} opt_fileId file Id.  If false, a new file is created.
     * @param {Object?} opt_params a dictionary containing the following keys
     *     pinned: whether this save should be pinned
     * @return {Promise} A promise resolved with the Google Drive Files
     *     resource for the uploaded file, or rejected with an Error object.
     */
    exports.upload_to_drive = function (data, metadata, opt_fileId, opt_params) {
        var params = opt_params || {};
        var delimiter = '\r\n--' + exports.MULTIPART_BOUNDARY + '\r\n';
        var close_delim = '\r\n--' + exports.MULTIPART_BOUNDARY + '--';
        var body = delimiter + 'Content-Type: application/json\r\n\r\n';
        var mime;
        if (metadata) {
            mime = metadata.mimeType;
            body += JSON.stringify(metadata);
        }
        body += delimiter;
        if (mime) {
            body += 'Content-Type: ' + mime + '\r\n';
            if (mime === 'application/octet-stream') {
                body += 'Content-Transfer-Encoding: base64\r\n';
            }
        }
        body += '\r\n' + data + close_delim;
        var path = '/upload/drive/v2/files';
        var method = 'POST';
        if (opt_fileId) {
            path += '/' + opt_fileId;
            method = 'PUT';
        }
        var request = gapi.client.request({
            'path': path,
            'method': method,
            'params': {
                'uploadType': 'multipart',
                'pinned': params['pinned']
            },
            'headers': {
                'Content-Type': 'multipart/mixed; boundary="' + exports.MULTIPART_BOUNDARY + '"'
            },
            'body': body
        });
        return gapi_utils.gapi_utils.execute(request);
    };
    exports.GET_CONTENTS_INITIAL_DELAY = 200; // 200 ms
    exports.GET_CONTENTS_MAX_TRIES = 5;
    exports.GET_CONTENTS_EXPONENTIAL_BACKOFF_FACTOR = 2.0;
    /**
     * Attempt to get the contents of a file with the given id.  This may
     * involve requesting the user to open the file in a FilePicker.
     * @param {Object} resource The files resource of the file.
     * @param {Boolean} already_picked Set to true if this file has already
     *     been selected by the FilePicker
     * @param {Number?} opt_num_tries The number tries left to open this file.
     *     Should be set when already_picked is true.
     * @return {Promise} A promise fullfilled by file contents.
     */
    exports.get_contents = function (resource, already_picked, opt_num_tries) {
        if (resource['downloadUrl']) {
            return gapi_utils.gapi_utils.download(resource['downloadUrl']);
        }
        else if (already_picked) {
            if (opt_num_tries == 0) {
                return Promise.reject(new Error('Max retries of file load reached'));
            }
            var request = gapi.client.drive.files.get({ 'fileId': resource['id'] });
            var reply = gapi_utils.gapi_utils.execute(request);
            var delay = exports.GET_CONTENTS_INITIAL_DELAY * Math.pow(exports.GET_CONTENTS_EXPONENTIAL_BACKOFF_FACTOR, exports.GET_CONTENTS_MAX_TRIES - opt_num_tries);
            var delayed_reply = new Promise(function (resolve, reject) {
                window.setTimeout(function () {
                    resolve(reply);
                }, delay);
            });
            return delayed_reply.then(function (new_resource) {
                return exports.get_contents(new_resource, true, opt_num_tries - 1);
            });
        }
        else {
            // If downloadUrl field is missing, this means that we do not have
            // access to the file using drive.file scope.  Therefore we prompt
            // the user to open a FilePicker window that allows them to indicate
            // to Google Drive that they intend to open that file with this
            // app.
            return picker_utils.pick_file(resource.parents[0]['id'], resource['title']).then(function () {
                return exports.get_contents(resource, true, exports.GET_CONTENTS_MAX_TRIES);
            });
        }
    };
    /**
     * Fetch user avatar url and put it in the header
     * optionally take a selector into which to insert the img tag
     *
     *
     *
     **/
    exports.set_user_info = function (selector) {
        selector = selector || '#header-container';
        var request = gapi.client.drive.about.get();
        return gapi_utils.gapi_utils.execute(request).then(function (result) {
            var user = result.user;
            var image = $('<img/>').attr('src', result.user.picture.url).addClass('pull-right').css('border-radius', '32px').css('width', '32px').css('margin-top', '-1px').css('margin-bottom', '-1px');
            image.attr('title', 'Logged in to Google Drive as ' + user.displayName);
            $('#header-container').prepend($('<span/>').append(image));
        });
    };
    exports.drive_utils = {
        FOLDER_MIME_TYPE: exports.FOLDER_MIME_TYPE,
        NOTEBOOK_MIMETYPE: exports.NOTEBOOK_MIMETYPE,
        FileType: exports.FileType,
        split_path: exports.split_path,
        get_id_for_path: exports.get_id_for_path,
        get_resource_for_relative_path: exports.get_resource_for_relative_path,
        get_resource_for_path: exports.get_resource_for_path,
        get_new_filename: exports.get_new_filename,
        upload_to_drive: exports.upload_to_drive,
        get_contents: exports.get_contents,
        set_user_info: exports.set_user_info
    };
});
