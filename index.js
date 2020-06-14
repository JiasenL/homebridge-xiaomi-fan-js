const miio = require('miio');
const ping = require('ping');
const fs = require('fs');
const ppath = require('persist-path');
const mkdirp = require('mkdirp');

let Service;
let Characteristic;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory('homebridge-xiaomi-fan', 'xiaomifan', xiaomiFanAccessory);
};

// --== MAIN CLASS ==--
class xiaomiFanAccessory {
    constructor(log, config) {
        this.log = log;

        // configuration
        this.name = config['name'];
        this.ip = config['ip'];
        this.token = config['token'];
        this.alivePollingInterval = config['pollingInterval'] || 5;
        this.alivePollingInterval = this.alivePollingInterval * 1000;
        this.prefsDir = config['prefsDir'] || ppath('xiaomiFan/');
        this.moveControl = config['moveControl'];
        if (this.moveControl == undefined) {
            this.moveControl = true;
        }
        this.buzzerControl = config['buzzerControl'];
        if (this.buzzerControl == undefined) {
            this.buzzerControl = true;
        }
        this.ledControl = config['ledControl'];
        if (this.ledControl == undefined) {
            this.ledControl = true;
        }

        if (!this.ip) {
            this.log.error("[ERROR]'ip' not defined! Please check your 'config.json' file.");
        }

        if (!this.token) {
            this.log.error("[ERROR]'token' not defined! Please check your 'config.json' file.");
        }

        // check if prefs directory ends with a /, if not then add it
        if (this.prefsDir.endsWith('/') === false) {
            this.prefsDir = this.prefsDir + '/';
        }

        // check if the tv preferences directory exists, if not then create it
        if (fs.existsSync(this.prefsDir) === false) {
            mkdirp(this.prefsDir);
        }

        this.fanModelInfo = this.prefsDir + 'info_' + this.ip.split('.').join('') + '_' + this.token;

        // prepare variables
        this.fanDevice = undefined;
        this.enabledServices = [];
        this.checkFanStatusInterval = null;

        //fan status
        this.isFanOn = false;
        this.fanRotationSpeed = 0;
        this.isChildLockActive = false;
        this.isSwingModeActive = false;
        this.isNaturalModeEnabled = false;
        this.isBuzzerEnabled = false;
        this.isLedEnabled = true;

        //preapre the services
        this.preapreFanServices();

        //try to initially connect to the device
        //  this.connectToFan(this.updateFanStatus.bind(this)); // do not need to do that, the checkFanStatus does this. 

        // USE miio.discover instead OF PING?
        // start the polling
        if (!this.checkFanStatusInterval) {
            this.checkFanStatusInterval = setInterval(this.checkFanState.bind(this, this.updateFanStatus.bind(this)), this.alivePollingInterval);
        }
    }


    // --== SETUP SERVICES  ==--
    preapreFanServices() {
        // info service

        // currently i save the fan model info in a file and load if it exists
        let modelName = this.name;
        try {
            modelName = fs.readFileSync(this.fanModelInfo);
        } catch (err) {
            this.log.debug('Xiaomi Fan - fan model info file does not exist');
        }

        this.informationService = new Service.AccessoryInformation();
        this.informationService
            .setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
            .setCharacteristic(Characteristic.Model, modelName)
            .setCharacteristic(Characteristic.SerialNumber, this.ip)
            .setCharacteristic(Characteristic.FirmwareRevision, '0.8.1');

        this.enabledServices.push(this.informationService);

        // fan service
        this.fanService = new Service.Fanv2(this.name, 'fanService');
        this.fanService
            .getCharacteristic(Characteristic.Active)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));
        this.fanService
            .addCharacteristic(Characteristic.RotationSpeed)
            .on('get', this.getRotationSpeed.bind(this))
            .on('set', this.setRotationSpeed.bind(this));
        this.fanService
            .addCharacteristic(Characteristic.LockPhysicalControls)
            .on('get', this.getLockPhysicalControls.bind(this))
            .on('set', this.setLockPhysicalControls.bind(this));
        this.fanService
            .addCharacteristic(Characteristic.SwingMode)
            .on('get', this.getSwingMode.bind(this))
            .on('set', this.setSwingMode.bind(this));
        this.fanService
            .addCharacteristic(Characteristic.RotationDirection) // used to switch between natural and normal mode
            .on('get', this.getRotationDirection.bind(this))
            .on('set', this.setRotationDirection.bind(this));

        this.enabledServices.push(this.fanService);


        // add move left/right buttons
        if (this.moveControl) {
            this.moveLeftService = new Service.Switch(this.name + ' Move left', 'moveLeftService');
            this.moveLeftService
                .getCharacteristic(Characteristic.On)
                .on('get', this.getMoveFanSwitch.bind(this))
                .on('set', (state, callback) => {
                    this.setMoveFanSwitch(state, callback, 'left');
                });

            this.enabledServices.push(this.moveLeftService);

            this.moveRightService = new Service.Switch(this.name + ' Move right', 'moveRightService');
            this.moveRightService
                .getCharacteristic(Characteristic.On)
                .on('get', this.getMoveFanSwitch.bind(this))
                .on('set', (state, callback) => {
                    this.setMoveFanSwitch(state, callback, 'right');
                });

            this.enabledServices.push(this.moveRightService);
        }


        // add buzzer button
        if (this.buzzerControl) {
            this.buzzerService = new Service.Switch(this.name + ' Buzzer', 'buzzerService');
            this.buzzerService
                .getCharacteristic(Characteristic.On)
                .on('get', this.getBuzzer.bind(this))
                .on('set', this.setBuzzer.bind(this));

            this.enabledServices.push(this.buzzerService);
        }


        // add led button
        if (this.ledControl) {
            this.ledService = new Service.Switch(this.name + ' LED', 'ledService');
            this.ledService
                .getCharacteristic(Characteristic.On)
                .on('get', this.getLed.bind(this))
                .on('set', this.setLed.bind(this));

            this.enabledServices.push(this.ledService);
        }
    }


    // --== HELPER METHODS ==--
    connectToFan(callback) {
        miio.device({
            address: this.ip,
            token: this.token
        }).then(device => {
            this.log.info('Xiaomi Fan - connected to Fan');
            this.log.info(device);
            this.fanDevice = device;

            // save model name
            if (fs.existsSync(this.fanModelInfo) === false) {
                fs.writeFile(this.fanModelInfo, device.miioModel, (err) => {
                    if (err) {
                        this.log.debug('Xiaomi Fan - error occured could not write fan model info %s', err);
                    } else {
                        this.log.debug('Xiaomi Fan - fan model info successfully saved!');
                    }
                });
            } else {
                this.log.debug('Xiaomi Fan - fan model info file already exists, not saving!');
            }

            callback(true);
            // WIP, try to find a way to make the events work, to get values from the fan only when something changes and also enable home automation
            /*
            device.defineProperty('power');
            device.defineProperty('speed');
            device.loadProperties(['power', 'speed']);
            device.onAny(power => console.log('Power changed to ', power));
            device.on('powerChanged', isOn => console.log('TEST EVENT ', isOn));
            device.on('power', isOn => console.log('TEST EVENT ', isOn));
            device.loadProperties(['power', 'speed']);
			*/
        }).catch(err => {
            console.log('Error ', err);
            this.fanDevice = undefined;
        });
    }

    checkFanState(callback) {
        ping.sys.probe(this.ip, (isAlive) => {
            if (!isAlive && this.fanDevice) {
                this.log.info('Xiaomi Fan - lost connection to fan. Disconnecting...');
                this.fanDevice.destroy();
                this.fanDevice = undefined;
                callback(false);
            } else if (isAlive && !this.fanDevice) {
                this.log.info('Xiaomi Fan - found Fan in network. Trying to connect...');
                this.connectToFan(callback);
            }
            if (isAlive === false) {
                this.log.debug('Xiaomi Fan - Fan not found');
            }
        });
    }

    updateFanStatus(isFanConnected) {
        if (this.fanService) this.fanService.getCharacteristic(Characteristic.Active).updateValue(isFanConnected ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    }

    updateFanPowerStatus() {
        if (this.fanDevice && this.fanService) {
            this.fanDevice.call('get_prop', ['power']).then(result => {
                this.log.debug('Xiaomi Fan - got power state from fan: %s', result[0]);
                this.isFanOn = result[0] === "on";
                this.updateFanStatus(this.isFanOn);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while requesting power state: %s', err);
            });
        }
    }

    updateFanRotationSpeed() {
        if (this.fanDevice && this.fanService) {
            this.fanDevice.call('get_prop', ["natural_level", "speed_level"]).then(result => {
                if (result[0] > 0) {
                    this.log.debug('Xiaomi Fan - got speed level from fan: %s. Mode: natural', result[0]);
                    this.fanRotationSpeed = result[0];
                } else {
                    this.log.debug('Xiaomi Fan - got speed level from fan: %s. Mode: standard', result[1]);
                    this.fanRotationSpeed = result[1];
                }
                if (this.fanService) this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.fanRotationSpeed);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while requesting speed level: %s', err);
            });
        }
    }

    updateFanChildLockState() {
        if (this.fanDevice && this.fanService) {
            this.fanDevice.call('get_prop', ['child_lock']).then(result => {
                this.log.debug('Xiaomi Fan - got child lock state from fan: %s', result[0]);
                this.isChildLockActive = result[0] === "on";
                if (this.fanService) this.fanService.getCharacteristic(Characteristic.LockPhysicalControls).updateValue(this.isChildLockActive ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while requesting child lock state: %s', err);
            });
        }
    }

    updateFanSwingModeState() {
        if (this.fanDevice && this.fanService) {
            this.fanDevice.call('get_prop', ['angle_enable']).then(result => {
                this.log.debug('Xiaomi Fan - got swing mode state from fan: %s', result[0]);
                this.isSwingModeActive = result[0] === "on";
                if (this.fanService) this.fanService.getCharacteristic(Characteristic.SwingMode).updateValue(this.isSwingModeActive ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while requesting swing mode state: %s', err);
            });
        }
    }

    updateFanNaturalModeState() {
        if (this.fanDevice && this.fanService) {
            this.fanDevice.call('get_prop', ['natural_level']).then(result => {
                console.log(result[0]);
                if (result[0] > 0) {
                    this.log.debug('Xiaomi Fan - got mode from fan: natural');
                    this.isNaturalModeEnabled = true;
                } else {
                    this.log.debug('Xiaomi Fan - got mode from fan: standard');
                    this.isNaturalModeEnabled = false;
                }
                if (this.fanService) this.fanService.getCharacteristic(Characteristic.RotationDirection).updateValue(this.isNaturalModeEnabled ? Characteristic.SwingMode.COUNTER_CLOCKWISE : Characteristic.SwingMode.CLOCKWISE);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while requesting mode: %s', err);
            });
        }
    }

    updateFanBuzzerState() {
        if (this.fanDevice && this.buzzerService) {
            this.fanDevice.call('get_prop', ['buzzer']).then(result => {
                this.log.debug('Xiaomi Fan - got buzzer state from fan: %s', result[0]);
                if (result[0] > 0) {
                    this.isBuzzerEnabled = true;
                } else {
                    this.isBuzzerEnabled = false;
                }
                if (this.buzzerService) this.buzzerService.getCharacteristic(Characteristic.RotationDirection).updateValue(this.isBuzzerEnabled);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while requesting buzzer state: %s', err);
            });
        }
    }

    updateFanLedState() {
        if (this.fanDevice && this.ledService) {
            this.fanDevice.call('get_prop', ['led_b']).then(result => {
                this.log.debug('Xiaomi Fan - got led state from fan: %s', result[0]);
                if (result[0] === 0 || result[0] === 1) {
                    this.isLedEnabled = true;
                } else {
                    this.isLedEnabled = false;
                }
                if (this.ledService) this.ledService.getCharacteristic(Characteristic.RotationDirection).updateValue(this.isLedEnabled);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while requesting led state: %s', err);
            });
        }
    }

    // --== HOMEBRIDGE STATE SETTERS/GETTERS ==--
    getPowerState(callback) {
        if (this.fanDevice) {
            this.updateFanPowerStatus();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
        callback(null, this.isFanOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    }

    setPowerState(state, callback) {
        if (this.fanDevice) {
            var powerState = state === Characteristic.Active.ACTIVE ? 'on' : 'off';
            this.fanDevice.call('set_power', [powerState]).then(result => {
                this.log.debug('Xiaomi Fan - successfully set power state to: %s. Result: %s', powerState, result);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while setting power state to: %s. Error: %s', powerState, err);
            });
            this.isFanOn = state === Characteristic.Active.ACTIVE;
            callback();
        }
    }

    getRotationSpeed(callback) {
        if (this.fanDevice) {
            this.updateFanRotationSpeed();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
        callback(null, this.fanRotationSpeed);
    }

    setRotationSpeed(value, callback) {
        if (this.fanDevice) {
            if (value > 0) {
                let isInNaturalMode = this.fanService.getCharacteristic(Characteristic.RotationDirection).value;
                var modeMethodName = "set_speed_level";
                if (isInNaturalMode == Characteristic.RotationDirection.COUNTER_CLOCKWISE) {
                    modeMethodName = "set_natural_level";
                }

                this.fanDevice.call(modeMethodName, [value]).then(result => {
                    if (result[0] === "ok") {
                        this.log.debug('Xiaomi Fan - successfully set speed level to: %d. Result: %s', value, result);
                    } else {
                        this.log.debug('Xiaomi Fan - error while setting speed level to: %d. Result: %s', value, result);
                    }
                }).catch(err => {
                    this.log.debug('Xiaomi Fan - error while setting speed level to: %d. Error: %s', value, err);
                });
            }
            this.fanRotationSpeed = value;
            callback();
        }
    }

    getLockPhysicalControls(callback) {
        if (this.fanDevice) {
            this.updateFanChildLockState();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
        callback(null, this.isChildLockActive ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
    }

    setLockPhysicalControls(state, callback) {
        if (this.fanDevice) {
            var childLockState = state === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? 'on' : 'off';
            this.fanDevice.call('set_child_lock', [childLockState]).then(result => {
                this.log.debug('Xiaomi Fan - successfully set child lock state to: %s. Result: %s', childLockState, result);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while setting child lock state to: %s. Error: %s', childLockState, err);
            });
            this.isChildLockActive = state === Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
            callback();
        }
    }

    getSwingMode(callback) {
        if (this.fanDevice) {
            this.updateFanSwingModeState();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
        callback(null, this.isSwingModeActive ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
    }

    setSwingMode(state, callback) {
        if (this.fanDevice) {
            var swingModeState = state === Characteristic.SwingMode.SWING_ENABLED ? 'on' : 'off';
            this.fanDevice.call('set_angle_enable', [swingModeState]).then(result => {
                this.log.debug('Xiaomi Fan - successfully set swing mode state to: %s. Result: %s', swingModeState, result);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while setting swing mode state to: %s. Error: %s', swingModeState, err);
            });
            this.isSwingModeActive = state === Characteristic.SwingMode.SWING_ENABLED;
            callback();
        }
    }

    getRotationDirection(callback) {
        if (this.fanDevice) {
            this.updateFanNaturalModeState();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
        callback(null, this.isNaturalModeEnabled ? Characteristic.SwingMode.COUNTER_CLOCKWISE : Characteristic.SwingMode.CLOCKWISE);
    }

    setRotationDirection(state, callback) {
        if (this.fanDevice) {
            let currentRotationSpeed = this.fanService.getCharacteristic(Characteristic.RotationSpeed).value;
            var modeState = state === Characteristic.RotationDirection.COUNTER_CLOCKWISE ? 'set_natural_level' : 'set_speed_level';
            var mode = state === Characteristic.RotationDirection.COUNTER_CLOCKWISE ? 'natural' : 'standard';
            this.fanDevice.call(modeState, [currentRotationSpeed]).then(result => {
                this.log.debug('Xiaomi Fan - successfully set mode to: %s. Current rotation speed: %d. Result: %s', mode, currentRotationSpeed, result);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while setting mode to: %s. Current rotation speed: %d. Error: %s', mode, currentRotationSpeed, err);
            });
            this.isNaturalModeEnabled = state === Characteristic.RotationDirection.COUNTER_CLOCKWISE;
            callback();
        }
    }

    getMoveFanSwitch(callback) {
        if (this.fanDevice) {
            callback(null, false);
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
    }

    setMoveFanSwitch(state, callback, direction) {
        if (this.fanDevice) {
            this.log.debug('Xiaomi Fan - fan move service - direction: %s', direction);
            this.fanDevice.call('set_move', [direction]).then(result => {
                this.log.debug('Xiaomi Fan - fan move service - successfully moved fan to %s. Result: %s', direction, result);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - fan move service - error moving fan to: %s. Error: %s', direction, err);
            });
            setTimeout(() => {
                if (this.moveLeftService) this.moveLeftService.getCharacteristic(Characteristic.On).updateValue(false);
                if (this.moveRightService) this.moveRightService.getCharacteristic(Characteristic.On).updateValue(false);
            }, 10);
            callback();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
    }

    getBuzzer(callback) {
        if (this.fanDevice) {
            this.updateFanBuzzerState();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
        callback(null, this.isBuzzerEnabled);
    }

    setBuzzer(state, callback) {
        if (this.fanDevice) {
            var buzzerVal = state === true ? 2 : 0;
            this.fanDevice.call('set_buzzer', [buzzerVal]).then(result => {
                this.log.debug('Xiaomi Fan - successfully set buzzer state to: %s. Result: %s', state, result);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while setting buzzer state to: %s. Error: %s', state, err);
            });
            this.isBuzzerEnabled = state;
            callback();
        }
    }

    getLed(callback) {
        if (this.fanDevice) {
            this.updateFanLedState();
        } else {
            callback(new Error('Xiaomi Fan - cannot connect to fan!'));
        }
        callback(null, this.isLedEnabled);
    }

    setLed(state, callback) {
        var ledBrighntess = state === true ? 0 : 2;
        if (this.fanDevice) {
            this.fanDevice.call('set_led_b', [ledBrighntess]).then(result => {
                this.log.debug('Xiaomi Fan - successfully set led state to: %s. Result: %s', state, result);
            }).catch(err => {
                this.log.debug('Xiaomi Fan - error while setting led state to: %s. Error: %s', state, err);
            });
            this.isLedEnabled = state;
            callback();
        }
    }

    getServices() {
        return this.enabledServices;
    }
}

