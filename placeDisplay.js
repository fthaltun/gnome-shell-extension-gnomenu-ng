/* ========================================================================================================
 * placeDisplay.js - Places Manager for Gnome Shell 3.6
 * --------------------------------------------------------------------------------------------------------
 *  CREDITS:  This code was copied from the Places Status Indicator extension and modified to provide the
 *  functions needed by GnoMenu. Many thanks to gcampax for a great extension.
 * ========================================================================================================
 */


const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const St = imports.gi.St;

const DND = imports.ui.dnd;
const Main = imports.ui.main;
const Params = imports.misc.params;
const Search = imports.ui.search;
const Util = imports.misc.util;

const Gettext = imports.gettext.domain('gnomenu-ng');
const _ = Gettext.gettext;
const N_ = function(x) { return x; }

let UseSymbolicIcons = false;

var PlaceInfo = class GnoMenu_PlaceInfo {

    constructor() {
        this._init.apply(this, arguments);
    }

    _init(kind, file, name, icon) {
        this.kind = kind;
        this.file = file;
        //this.name = name || this._getFileName();
        this.name = name ? name : this._getFileName();
        this.icon = icon ? new Gio.ThemedIcon({ name: icon }) : this.getIcon();
    }

    isRemovable() {
        return false;
    }

    launch(timestamp) {
        //let time = global.get_current_time();
        let launchContext = global.create_app_launch_context(0, -1);
        launchContext.set_timestamp(timestamp);

        try {
            Gio.AppInfo.launch_default_for_uri(this.file.get_uri(),
                                               launchContext);
        } catch(e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_MOUNTED)) {
                this.file.mount_enclosing_volume(0, null, null, function(file, result) {
                    file.mount_enclosing_volume_finish(result);
                    Gio.AppInfo.launch_default_for_uri(file.get_uri(), launchContext);
                });
            } else {
                Main.notifyError(_("Failed to launch \"%s\"").format(this.name), e.message);
            }
        }
    }

    getIcon() {
        try {
            let info;
            if (UseSymbolicIcons) {
                info = this.file.query_info('standard::symbolic-icon', 0, null);
                return info.get_symbolic_icon();
            } else {
                info = this.file.query_info("standard::icon", 0, null);
                return info.get_icon();
            }
        } catch(e) {
            if (e instanceof Gio.IOErrorEnum) {
                // return a generic icon for this kind
                switch (this.kind) {
                case 'network':
                    return new Gio.ThemedIcon({ name: 'folder-remote-symbolic' });
                case 'devices':
                    return new Gio.ThemedIcon({ name: 'drive-harddisk-symbolic' });
                case 'special':
                case 'bookmarks':
                default:
                    if (!this.file.is_native())
                        return new Gio.ThemedIcon({ name: 'folder-remote-symbolic' });
                    else
                        return new Gio.ThemedIcon({ name: 'folder-symbolic' });
                }
            }
        }
    }

    _getFileName() {
        try {
            let info = this.file.query_info('standard::display-name', 0, null);
            return info.get_display_name();
        } catch(e) {
            if (e instanceof Gio.IOErrorEnum) {
                return this.file.get_basename();
            }
        }
    }


};

var PlaceDeviceInfo = class GnoMenu_PlaceDeviceInfo extends PlaceInfo {

    _init(kind, mount) {
        this._mount = mount;
        super._init(kind, mount.get_root(), mount.get_name());
    }

    getIcon() {
        if (UseSymbolicIcons)
            return this._mount.get_symbolic_icon();
        else
            return this._mount.get_icon();
    }
};

const DEFAULT_DIRECTORIES = [
    GLib.UserDirectory.DIRECTORY_DOCUMENTS,
    GLib.UserDirectory.DIRECTORY_DOWNLOAD,
    GLib.UserDirectory.DIRECTORY_MUSIC,
    GLib.UserDirectory.DIRECTORY_PICTURES,
    GLib.UserDirectory.DIRECTORY_VIDEOS
];

var PlacesManager = class GnoMenu_PlacesManager {

    constructor(useSymbolic) {
        UseSymbolicIcons = useSymbolic;

        this._places = {
            special: [],
            devices: [],
            bookmarks: [],
            network: [],
        };

        let homePath = GLib.get_home_dir();

        this._places.special.push(new PlaceInfo('special',
                                                Gio.File.new_for_path(homePath),
                                                _("Home")));


        for (let i = 0; i < DEFAULT_DIRECTORIES.length; i++) {
            let specialPath = GLib.get_user_special_dir(DEFAULT_DIRECTORIES[i]);
            if (specialPath) {
                if (specialPath == homePath)
                    continue;
                this._places.special.push(new PlaceInfo('special',
                                                        Gio.File.new_for_path(specialPath)));
            }
        }

        /*
        * Show devices, code more or less ported from nautilus-places-sidebar.c
        */
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._connectVolumeMonitorSignals();
        this._updateMounts();

        this._bookmarksFile = this._findBookmarksFile(); // Passingthru67 - Added missing semi-colon
        this._bookmarkTimeoutId = 0;
        this._monitor = null;

        if (this._bookmarksFile) {
            this._monitor = this._bookmarksFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => {
                if (this._bookmarkTimeoutId > 0)
                    return;
                /* Defensive event compression */
                this._bookmarkTimeoutId = Mainloop.timeout_add(100, () => {
                    this._bookmarkTimeoutId = 0;
                    this._reloadBookmarks();
                    return false;
                });
            });
            this._reloadBookmarks();
        }
    }

    _connectVolumeMonitorSignals() {
        const signals = ['volume-added', 'volume-removed', 'volume-changed',
                         'mount-added', 'mount-removed', 'mount-changed',
                         'drive-connected', 'drive-disconnected', 'drive-changed'];

        this._volumeMonitorSignals = [];
        let func = this._updateMounts.bind(this);
        for (let i = 0; i < signals.length; i++) {
            let id = this._volumeMonitor.connect(signals[i], func);
            this._volumeMonitorSignals.push(id);
        }
    }

    destroy() {
        for (let i = 0; i < this._volumeMonitorSignals.length; i++)
            this._volumeMonitor.disconnect(this._volumeMonitorSignals[i]);

        if (this._monitor)
            this._monitor.cancel();
        if (this._bookmarkTimeoutId)
            Mainloop.source_remove(this._bookmarkTimeoutId);
    }

    _updateMounts() {
        this._places.devices = [];
        this._places.network = [];

        /* Add standard places */
        let symbolic = "";
        if (UseSymbolicIcons) {
            symbolic = "-symbolic";
        }
        this._places.devices.push(new PlaceInfo('devices',
                                                Gio.File.new_for_path('/'),
                                                _("Computer"),
                                                'drive-harddisk'+symbolic));
        this._places.network.push(new PlaceInfo('network',
                                                Gio.File.new_for_uri('network:///'),
                                                _("Browse network"),
                                                'network-workgroup'+symbolic));


        /* first go through all connected drives */
        let drives = this._volumeMonitor.get_connected_drives();
        for (let i = 0; i < drives.length; i++) {
            let volumes = drives[i].get_volumes();

            for(let j = 0; j < volumes.length; j++) {
                let mount = volumes[j].get_mount();
                let kind = 'devices';
                let identifier = volumes[j].get_identifier('class');
                if (identifier && identifier.indexOf('network') >= 0)
                    kind = 'network';

                if(mount != null)
                    this._addMount(kind, mount);
            }
        }


        /* add all volumes that is not associated with a drive */
        let volumes = this._volumeMonitor.get_volumes();
        for(let i = 0; i < volumes.length; i++) {
            if(volumes[i].get_drive() != null)
                continue;

            let kind = 'devices';
            let identifier = volumes[i].get_identifier('class');
            if (identifier && identifier.indexOf('network') >= 0)
                kind = 'network';

            let mount = volumes[i].get_mount();
            if(mount != null)
                this._addMount(kind, mount);
        }


        /* add mounts that have no volume (/etc/mtab mounts, ftp, sftp,...) */
        let mounts = this._volumeMonitor.get_mounts();
        for(let i = 0; i < mounts.length; i++) {
            if(mounts[i].is_shadowed())
                continue;

            if(mounts[i].get_volume())
                continue;

            let root = mounts[i].get_default_location();
            let kind;
            if (root.is_native())
                kind = 'devices';
            else
                kind = 'network';

            this._addMount(kind, mounts[i]);
        }


        this.emit('devices-updated');
        this.emit('network-updated');
    }

    _findBookmarksFile() {
        let paths = [
            GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-3.0', 'bookmarks']),
            GLib.build_filenamev([GLib.get_home_dir(), '.gtk-bookmarks']),
        ];

        for (let i = 0; i < paths.length; i++) {
            if (GLib.file_test(paths[i], GLib.FileTest.EXISTS)) {
                return Gio.File.new_for_path(paths[i]);
            }
        }

        return null;
    }

    _reloadBookmarks() {
        this._bookmarks = [];

        let content = Shell.get_file_contents_utf8_sync(this._bookmarksFile.get_path());
        let lines = content.split('\n');

        let bookmarks = [];
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let components = line.split(' ');
            let bookmark = components[0];

            if (!bookmark)
                continue;

            let file = Gio.File.new_for_uri(bookmark);
            if (file.is_native() && !file.query_exists(null))
                continue;

            let duplicate = false;
            for (let i = 0; i < this._places.special.length; i++) {
                if (file.equal(this._places.special[i].file)) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate)
                continue;
            for (let i = 0; i < bookmarks.length; i++) {
                if (file.equal(bookmarks[i].file)) {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate)
                continue;

            let label = null;
            if (components.length > 1)
                label = components.slice(1).join(' ');

            bookmarks.push(new PlaceInfo('bookmarks', file, label));
        }

        this._places.bookmarks = bookmarks;

        this.emit('bookmarks-updated');
    }

    _addMount(kind, mount) {
        let devItem = new PlaceDeviceInfo(kind, mount);
        this._places[kind].push(devItem);
    }

    getPlace(kind) {
        return this._places[kind];
    }

    getAllPlaces() {
        return this._places['special'].concat(this._places['bookmarks'], this._places['devices']);
    }

    getDefaultPlaces() {
        return this._places['special'];
    }

    getBookmarks() {
        return this._places['bookmarks'];
    }

    getMounts() {
        return this._places['devices'];
    }
};
Signals.addSignalMethods(PlacesManager.prototype);
