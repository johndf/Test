/* jshint node: true */
// Wemo Platform Plugin for HomeBridge (https://github.com/nfarina/homebridge)
//
// Remember to add platform to config.json. Example:
// "platforms": [
//      {
//          "platform": "BelkinWeMo",
//          "name": "Belkin WeMo",
//          "no_motion_timer": 60 // optional: [WeMo Motion only] a timer (in seconds) which is started no motion is detected, defaults to 60
//      }
// ],

"use strict";

var Wemo  = require('wemo-client'),
    debug = require('debug')('homebridge-platform-wemo');

var Accessory, Characteristic, Consumption, Service, TotalConsumption, UUIDGen;
var wemo = new Wemo();

var noMotionTimer;

module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    Characteristic = homebridge.hap.Characteristic;
    Service = homebridge.hap.Service;
    UUIDGen = homebridge.hap.uuid;

    Consumption = function() {
        Characteristic.call(this, 'Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52');

        this.setProps({
            format: Characteristic.Formats.UINT16,
            unit: 'W',
            perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });

        this.value = this.getDefaultValue();
    };
    require('util').inherits(Consumption, Characteristic);

    Consumption.UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

    TotalConsumption = function() {
        Characteristic.call(this, 'Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52');

        this.setProps({
            format: Characteristic.Formats.UINT32,
            unit: 'kWh',
            perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });

        this.value = this.getDefaultValue();
    };
    require('util').inherits(TotalConsumption, Characteristic);

    TotalConsumption.UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

    homebridge.registerPlatform("homebridge-platform-wemo", "BelkinWeMo", WemoPlatform, true);
};

function WemoPlatform(log, config, api) {
    this.config = config || {};

    var self = this;

    this.api = api;
    this.accessories = {};
    this.log = log;

    noMotionTimer = this.config.no_motion_timer || 60;

    var addDiscoveredDevice = function(device) {
        var uuid = UUIDGen.generate(device.UDN);
        var accessory;

        if (device.deviceType === Wemo.DEVICE_TYPE.Bridge) {
            var client = this.client(device , self.log);

            client.getEndDevices(function (err, enddevices) {
                for (var i = 0, tot = enddevices.length; i < tot; i++) {
                    uuid = UUIDGen.generate(enddevices[i].deviceId);
                    accessory = self.accessories[uuid];

                    if (accessory === undefined) {
                        self.addLinkAccessory(device, enddevices[i]);
                    }
                    else {
                        self.log("Online: %s [%s]", accessory.displayName, device.deviceId);
                        self.accessories[uuid] = new WemoLinkAccessory(self.log, accessory, device, enddevices[i]);
                    }
                }
            });
        }
        else {
            accessory = self.accessories[uuid];

            if (accessory === undefined) {
                self.addAccessory(device);
            }
            else if (accessory instanceof WemoAccessory) {
                self.log("Online and can update device: %s [%s]", accessory.displayName, device.macAddress);
                accessory.setupDevice(device);
                accessory.observeDevice(device);
            }
            else {
                self.log("Online: %s [%s]", accessory.displayName, device.macAddress);
               self.accessories[uuid] = new WemoAccessory(self.log, accessory, device);
            }
        }
    }

    this.api.on('didFinishLaunching', function() {
        wemo.discover(addDiscoveredDevice);
    });

    setInterval(
        function(){
            wemo.discover(addDiscoveredDevice);
        },
        60000
    );
}

WemoPlatform.prototype.addAccessory = function(device) {
    this.log("Found: %s [%s]", device.friendlyName, device.macAddress);

    var serviceType = getServiceType(device.deviceType);

    if (serviceType === undefined) {
        return;
    }

    var accessory = new Accessory(device.friendlyName, UUIDGen.generate(device.UDN));
    var service = accessory.addService(serviceType, device.friendlyName);

    switch(device.deviceType) {
        case Wemo.DEVICE_TYPE.Insight:
            service.addCharacteristic(Characteristic.OutletInUse);
            service.addCharacteristic(Consumption);
            service.addCharacteristic(TotalConsumption);
            break;
        case Wemo.DEVICE_TYPE.Maker:
            service.addCharacteristic(Characteristic.ContactSensorState);
            break;
    }

    this.accessories[accessory.UUID] = new WemoAccessory(this.log, accessory, device);
    this.api.registerPlatformAccessories("homebridge-platform-wemo", "BelkinWeMo", [accessory]);
}

WemoPlatform.prototype.addLinkAccessory = function(link, device) {
    this.log("Found: %s [%s]", device.friendlyName, device.deviceId);

    var accessory = new Accessory(device.friendlyName, UUIDGen.generate(device.deviceId));
    accessory.addService(Service.Lightbulb, device.friendlyName).addCharacteristic(Characteristic.Brightness);

    this.accessories[accessory.UUID] = new WemoLinkAccessory(this.log, accessory, link, device);
    this.api.registerPlatformAccessories("homebridge-platform-wemo", "BelkinWeMo", [accessory]);
}

WemoPlatform.prototype.configureAccessory = function(accessory) {
    this.accessories[accessory.UUID] = accessory;
}

WemoPlatform.prototype.configurationRequestHandler = function(context, request, callback) {
    var self = this;
    var respDict = {};

    if (request && request.type === "Terminate") {
        context.onScreen = null;
    }

    var sortAccessories = function() {
        context.sortedAccessories = Object.keys(self.accessories).map(
            function(k){return this[k] instanceof Accessory ? this[k] : this[k].accessory},
            self.accessories
        ).sort(function(a,b) {if (a.displayName < b.displayName) return -1; if (a.displayName > b.displayName) return 1; return 0});

        return Object.keys(context.sortedAccessories).map(function(k) {return this[k].displayName}, context.sortedAccessories);
    }

    switch(context.onScreen) {
        case "DoRemove":
            if (request.response.selections) {
                for (var i in request.response.selections.sort()) {
                    this.removeAccessory(context.sortedAccessories[request.response.selections[i]]);
                }

                respDict = {
                    "type": "Interface",
                    "interface": "instruction",
                    "title": "Finished",
                    "detail": "Accessory removal was successful."
                }

                context.onScreen = null;
                callback(respDict);
            }
            else {
                context.onScreen = null;
                callback(respDict, "platform", true, this.config);
            }
            break;
        case "Menu":
            context.onScreen = "Remove";
        case "Remove":
            respDict = {
                "type": "Interface",
                "interface": "list",
                "title": "Select accessory to " + context.onScreen.toLowerCase(),
                "allowMultipleSelection": context.onScreen == "Remove",
                "items": sortAccessories()
            }

            context.onScreen = "Do" + context.onScreen;
            callback(respDict);
            break;
        default:
            if (request && (request.response || request.type === "Terminate")) {
                context.onScreen = null;
                callback(respDict, "platform", true, this.config);
            }
            else {
                respDict = {
                    "type": "Interface",
                    "interface": "list",
                    "title": "Select option",
                    "allowMultipleSelection": false,
                    "items": ["Remove Accessory"]
                }

                context.onScreen = "Menu";
                callback(respDict);
            }
    }
}


WemoPlatform.prototype.removeAccessory = function(accessory) {
    this.log("Remove: %s", accessory.displayName);

    if (this.accessories[accessory.UUID]) {
        delete this.accessories[accessory.UUID];
    }

    this.api.unregisterPlatformAccessories("homebridge-platform-wemo", "BelkinWeMo", [accessory]);
}

function WemoAccessory(log, accessory, device) {
    var self = this;

    this.accessory = accessory;
    this.device = device;
    this.log = log;
    this.service = this.getService();

    this.setupDevice(device);
    this.updateReachability(true);

    this.accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "Belkin WeMo")
        .setCharacteristic(Characteristic.Model, device.modelName)
        .setCharacteristic(Characteristic.SerialNumber, device.serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, device.firmwareVersion);

    this.accessory.on('identify', function(paired, callback) {
        self.log("%s - identify", self.accessory.displayName);
        callback();
    });

    if (this.service.testCharacteristic(Characteristic.Name) === false) {
        this.service.addCharacteristic(Characteristic.Name);
    }

    if (this.service.getCharacteristic(Characteristic.Name).value === undefined) {
        this.service.getCharacteristic(Characteristic.Name).setValue(device.friendlyName);
    }

    this.observeDevice(device);
}

WemoAccessory.prototype.getAttributes = function(callback) {
    callback = callback || function() {};

    this.client.getAttributes(function(err, attributes) {
        if (err) {
            callback();
            return;
        }

        this.updateSwitchState(attributes.Switch);
        this.updateSensorState(attributes.Sensor);

        callback();
    }.bind(this));
}

WemoAccessory.prototype.getSwitchState = function(callback) {
    if (this.device.deviceType === Wemo.DEVICE_TYPE.Maker) {
        this.getAttributes(function() {
            callback(null, this.service.getCharacteristic(Characteristic.On).value);
        }.bind(this));
    }
    else {
        this.client.getBinaryState(function(err, state) {
            if (err) {
                callback(null, this.service.getCharacteristic(Characteristic.On).value);
                return;
            }

            callback(null, this.updateSwitchState(state));
        }.bind(this));
    }
}

WemoAccessory.prototype.getService = function() {
    var service = getServiceType(this.device.deviceType);

    if (service === undefined) {
        return;
    }

    return this.accessory.getService(service);
}

WemoAccessory.prototype.observeDevice = function (device) {
    if (device.deviceType === Wemo.DEVICE_TYPE.Maker) {
        this.getAttributes();

        this.client.on('attributeList', function(name, value, prevalue, timestamp) {
            switch(name) {
                case 'Switch':
                    this.updateSwitchState(value);
                    break;
                case 'Sensor':
                    this.updateSensorState(value);
                    break;
            }
        }.bind(this));
    }
    else {
        this.client.on('binaryState', function(state) {
            if (this.device.deviceType === Wemo.DEVICE_TYPE.Motion || this.device.deviceType === "urn:Belkin:device:NetCamSensor:1") {
                this.updateMotionDetected(state);
            }
            else {
                this.updateSwitchState(state);
            }
        }.bind(this));
    }

    if (device.deviceType === Wemo.DEVICE_TYPE.Insight) {
        this.client.on('insightParams', this.updateInsightParams.bind(this));
    }
}

WemoAccessory.prototype.setSwitchState = function (state, callback) {
    var value = state > 0;
    var switchState = this.service.getCharacteristic(Characteristic.On);
    callback = callback || function() {};

    if (switchState.value != value) {  //remove redundent calls to setBinaryState when requested state is already achieved
        this.client.setBinaryState(value | 0, function (err) {
            if(!err) {
                this.log("%s - Set state: %s", this.accessory.displayName, (value ? "on" : "off"));
                //this.onState = value;
                callback(null);
            }
            else {
                this.log("%s - Set state FAILED: %s. Error: %s", this.accessory.displayName, (value ? "on" : "off"), err.code);
                callback(new Error(err));
            }
        }.bind(this));
    }
    else {
        callback(null);
    }
}

WemoAccessory.prototype.setupDevice = function(device) {
    this.device = device;
    this.client = wemo.client(device);

    this.client.on('error', function(err) {
        this.log('%s reported error %s', self.accessory.displayName, err.code);
    }.bind(this));
}

WemoAccessory.prototype.updateConsumption = function(raw) {
    var value = Math.round(raw / 1000);

    if (this.service.getCharacteristic(Consumption).value !== value) {
        this.log("%s - Consumption: %sw", this.accessory.displayName, value);
        this.service.getCharacteristic(Consumption).setValue(value);
    }

    return value;
}

WemoAccessory.prototype.updateEventHandlers= function(characteristic) {
    if (this.service === undefined) {
        return;
    }

    if (this.service.testCharacteristic(characteristic) === false) {
        return;
    }

    this.service.getCharacteristic(characteristic).removeAllListeners();

    if (this.accessory.reachable !== true) {
        return;
    }

    switch(characteristic) {
        case Characteristic.On:
            this.service
                .getCharacteristic(characteristic)
                .on('get', this.getSwitchState.bind(this))
                .on('set', this.setSwitchState.bind(this));
            break;
    }
}

WemoAccessory.prototype.updateInsightParams = function(state, power, data) {
    this.updateOutletInUse(state);
    this.updateConsumption(power);
    this.updateTotalConsumption(data.TodayConsumed);
}

WemoAccessory.prototype.updateOutletInUse = function(state) {
    var value = state == 1;
    var outletInUse = this.service.getCharacteristic(Characteristic.OutletInUse);

    if (outletInUse.value !== value) {
        this.log("%s - Outlet In Use: %s", this.accessory.displayName, (value ? "Yes" : "No"));
        outletInUse.setValue(value);
    }

    return value;
}

WemoAccessory.prototype.updateMotionDetected = function(state) {
    var value = state > 0;
    var motionDetected = this.service.getCharacteristic(Characteristic.MotionDetected);

    if (value === motionDetected.value || (value === false && this.motionTimer)) {
        return;
    }

    if (value === true || noMotionTimer == 0) {
        if (this.motionTimer) {
            this.log("%s - no motion timer stopped", this.accessory.displayName);
            clearTimeout(self.motionTimer);
            this.motionTimer = null;
        }

        this.log("%s - Motion Sensor: %s", this.accessory.displayName, (value ? "Detected" : "Clear"));
        motionDetected.setValue(value);
    }
    else {
        this.log("%s - no motion timer started [%d secs]", this.accessory.displayName, noMotionTimer);
        clearTimeout(this.motionTimer);
        this.motionTimer = setTimeout(function(self) {
            self.log("%s - Motion Sensor: Clear; no motion timer completed", self.accessory.displayName);
            self.service.getCharacteristic(Characteristic.MotionDetected).setValue(false);
            self.motionTimer = null;
        }, noMotionTimer * 1000, this);
    }
}

WemoAccessory.prototype.updateReachability = function(reachable) {
    this.accessory.updateReachability(reachable);

    switch(this.device.deviceType) {
        case Wemo.DEVICE_TYPE.Insight:
        case Wemo.DEVICE_TYPE.LightSwitch:
        case Wemo.DEVICE_TYPE.Maker:
        case Wemo.DEVICE_TYPE.Switch:
            this.updateEventHandlers(Characteristic.On);
            break;
        case Wemo.DEVICE_TYPE.Motion:
        case "urn:Belkin:device:NetCamSensor:1":
            break;
        default:
            console.log("Not implemented");
    }
}

WemoAccessory.prototype.updateSensorState = function(state) {
    var value = !(state > 0);
    var sensorState = this.service.getCharacteristic(Characteristic.ContactSensorState);

    if (sensorState.value !== value) {
        this.log("%s - Sensor: %s", this.accessory.displayName, (value ? "Detected" : "Not detected"));
        sensorState.setValue(value ?  Characteristic.ContactSensorState.CONTACT_DETECTED: Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    }

    return value;
}

WemoAccessory.prototype.updateSwitchState = function(state) {
    var value = state > 0;
    var switchState = this.service.getCharacteristic(Characteristic.On)

    if (switchState.value !== value) {
        this.log("%s - Get state: %s", this.accessory.displayName, (value ? "On" : "Off"));
        switchState.setValue(value);

        if(value === false && this.device.deviceType === Wemo.DEVICE_TYPE.Insight) {
            this.updateOutletInUse(0);
            this.updateConsumption(0);
        }
    }

    return value;
}

WemoAccessory.prototype.updateTotalConsumption = function(raw) {
    var value = Math.round(raw / 10000 * 6) / 100;
    var totalConsumption = this.service.getCharacteristic(TotalConsumption);

    if (totalConsumption.value !== value) {
        this.log("%s - Total Consumption: %skwh", this.accessory.displayName, value);
        totalConsumption.setValue(value);
    }

    return value;
}

function WemoLinkAccessory(log, accessory, link, device) {
    var self = this;

    this.accessory = accessory;
    this.link = link;
    this.device = device;
    this.log = log;
    this.client = wemo.client(link, log);
    this.onState = false;
    this.brightness = null;

    this.client.on('error', function(err) {
        self.log('%s reported error %s', self.accessory.displayName, err.code);
    });

    this.updateReachability(true);

    this.accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "Belkin WeMo")
        .setCharacteristic(Characteristic.SerialNumber, device.deviceId);

    this.accessory.on('identify', function(paired, callback) {
        self.log("%s - identify", self.accessory.displayName);
        callback();
    });

    var service = this.accessory.getService(Service.Lightbulb);

    if (service.testCharacteristic(Characteristic.Name) === false) {
        service.addCharacteristic(Characteristic.Name);
    }

    if (service.getCharacteristic(Characteristic.Name).value === undefined) {
        service.getCharacteristic(Characteristic.Name).setValue(device.friendlyName);
    }

    // we can't depend on the capabilities returned from Belkin so we'll go ask expliciitly.
    this.getStatus(function (err) {
        self.onState = (self.device.capabilities[WemoLinkAccessory.OPTIONS.Switch].substr(0,1) === '1') ? true : false ;
        self.log("%s (bulb) reported as %s", self.accessory.displayName, self.onState ? "on" : "off");
        self.brightness = Math.round(self.device.capabilities[WemoLinkAccessory.OPTIONS.Brightness].split(':').shift() * 100 / 255 );
        self.log("%s (bulb) reported as at %s%% brightness", self.accessory.displayName, self.brightness);
    });

    // register eventhandler
    this.client.on('statusChange', function(deviceId, capabilityId, value) {
        self.statusChange(deviceId, capabilityId, value);
    });
}

WemoLinkAccessory.OPTIONS = {
    Brightness: '10008',
    Color:      '10300',
    Switch:     '10006'
}

WemoLinkAccessory.prototype.getStatus = function (callback) {
    // this function is called on initialisation of a Bulbs because we can't rely on Belkin's
    // capabilities structure on initialisation so we'll explicity retrieve it here.
    callback = callback || function() {};

    this.client.getDeviceStatus(this.device.deviceId, function (err, capabilities) {
        if(err) {
            callback("unknown error getting device status (getStatus)", capabilities);
            return;
        }

        if (!capabilities[WemoLinkAccessory.OPTIONS.Switch].length) { // we've get no data in the capabilities array, so it's off
            this.log("%s appears to be off, i.e. at the power!", this.name);
        }
        else {
            //this.log("getStatus: %s is ", this.name, capabilities);
            this._capabilities = capabilities;
        }

        callback(null)
    }.bind(this));
}

WemoLinkAccessory.prototype.setBrightness = function (value, callback) {
    this._brightness = value;
    callback = callback || function() {};

    //defer the actual update by 100 milliseconds to smooth out changes from sliders
    setTimeout(function(brightness, caller) {
        //check that we actually have a change to make and that something
        //hasn't tried to update the brightness again in the last 100 milliseconds
        if(caller.brightness !== brightness && caller._brightness == brightness) {
            caller.client.setDeviceStatus(caller.device.deviceId, WemoLinkAccessory.OPTIONS.Brightness, brightness * 255 / 100);
            caller.log("setBrightness: %s to %s%%", caller.accessory.displayName, brightness);
            caller.brightness = brightness;
        }
    }, 100, value, this);

    callback(null);
}

WemoLinkAccessory.prototype.setOnStatus = function (value, callback) {
    this.log("this.Onstate currently %s, value is %s", this.onState, value );
    callback = callback || function() {};

    if(this.onState !== value) { // if we have nothing to do so lets leave it at that.
        this.onState = value;
        this.log("this.Onstate now: %s", this.onState);
        this.log("setOnStatus: %s to %s", this.accessory.displayName, value > 0 ? "on" : "off");
        this.client.setDeviceStatus(this.device.deviceId, WemoLinkAccessory.OPTIONS.Switch, value | 0, function(err, response) {
            callback(null);
        });
    }
}

WemoLinkAccessory.prototype.statusChange = function(deviceId, capabilityId, value) {
        // We receive this notification if the wemo's are changed by Homekit (i.e us) or
        // some other trigger (i.e. any of the pethora of wemo apps).
        // We want to update homekit with these changes,
        // to do that we need to use setValue which triggers another call back to here which
        // we need to ignore - much of this function deals with the idiosyncrasies around this issue.

    if (this.device.deviceId !== deviceId){
        // we get called for every bulb on the link so lets get out of here if the call is for a differnt bulb
        this.log('statusChange Ignored (device): ', this.device.deviceId, deviceId, capabilityId, value);
        return;
    }

    if (this.device.capabilities[capabilityId] === value) {
        // nothing's changed - lets get out of here to stop an endless loop as
        // this callback was probably triggered by us updating HomeKit
        this.log('statusChange Ignored (capability): ', deviceId, capabilityId, value);
        return;
    }

    this.log('statusChange processing: ', deviceId, capabilityId, value);

    // update our internal array with newly passed value.
    this.device.capabilities[capabilityId] = value;

    switch(capabilityId) {
        case WemoLinkAccessory.OPTIONS.Brightness: // this is a brightness change
            // update our convenience variable ASAP to minimise race condition possibiities
            var newbrightness = Math.round(this.device.capabilities[WemoLinkAccessory.OPTIONS.Brightness].split(':').shift() * 100 / 255 );

            // changing wemo bulb brightness always turns them on so lets reflect this locally and in homekit.
            // do we really need this or do we get both status change messages from wemo?
            if (!this.onState){ // if off
                this.log('Update homekit onState: %s is %s', this.accessory.displayName, true);
                this.device.capabilities[WemoLinkAccessory.OPTIONS.Switch] = '1';
                this.accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).setValue(true);
            }

            // call setValue to update HomeKit and iOS (this generates another statusChange that will get ignored)
            this.log('Update homekit brightness: %s is %s', this.accessory.displayName, newbrightness);
            this.accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness).setValue(newbrightness);
            break;
        case WemoLinkAccessory.OPTIONS.Switch: // on/off/etc
            // reflect change of onState from potentially and external change (from Wemo App for instance)
            var newState = (this.device.capabilities[WemoLinkAccessory.OPTIONS.Switch].substr(0,1) === '1') ? true : false;
            // similarly we need to update iOS with this change - which will trigger another state shange which we'll ignore
            this.log('Update homekit onState: %s is %s', this.accessory.displayName, newState);
            this.accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On).setValue(newState);
            break;
        default:
            console.log("This capability (%s) not implemented", capabilityId);
    }
}

WemoLinkAccessory.prototype.updateEventHandlers= function (characteristic) {
    var self = this;
    var service = this.accessory.getService(Service.Lightbulb)

    if (service.testCharacteristic(characteristic) === false) {
        return;
    }

    service.getCharacteristic(characteristic).removeAllListeners();

    if (this.accessory.reachable !== true) {
        return;
    }

    switch(characteristic) {
        case Characteristic.On:
            service
                .getCharacteristic(Characteristic.On)
                .on('set', this.setOnStatus.bind(this))
                .on('get', function(callback) {callback(null, self.onState)});
            break;
        case Characteristic.Brightness:
            service
                .getCharacteristic(Characteristic.Brightness)
                .on('set', this.setBrightness.bind(this))
                .on('get', function(callback) {callback(null, self.brightness)});
            break;
    }
}

WemoLinkAccessory.prototype.updateReachability = function(reachable) {
    this.accessory.updateReachability(reachable);
    this.updateEventHandlers(Characteristic.On);
    this.updateEventHandlers(Characteristic.Brightness);
}

function getServiceType(deviceType) {
    var service;

    switch(deviceType) {
        case Wemo.DEVICE_TYPE.Insight:
        case Wemo.DEVICE_TYPE.LightSwitch:
        case Wemo.DEVICE_TYPE.Maker:
            service = Service.GarageDoorOpener;
        case Wemo.DEVICE_TYPE.Switch:
            service = Service.Switch;
            break;
        case Wemo.DEVICE_TYPE.Motion:
        case "urn:Belkin:device:NetCamSensor:1":
            service = Service.MotionSensor;
            break;
        default:
            console.log("Not Supported: %s", deviceType);
    }

    return service;
}
