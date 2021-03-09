'use strict'

const util = require('util')
const os = require("os")
const fs = require("fs")
const mqtt = require('mqtt')
const stringify = require('json-stable-stringify')
const {
    RokuClient,
    Keys
} = require('roku-client')
const {
    getIPRange
} = require('get-ip-range')

const mh = require('./my-helpers')

var config = mh.readConfig('./config.json')

var myName = 'roku-mqtt'

var mqttConf = {
    ...config.mqtt_conf
}

util.inspect.defaultOptions.maxArrayLength = null
util.inspect.defaultOptions.depth = null

var expireIpAfter = (config.discover_expire ? mh.durationToSeconds(config.discover_expire) : (12 * 3600)) * 1000
var pollActive = config.poll_active ? config.poll_active * 1000 : 5000
var pollIdle = config.poll_idle ? config.poll_idle * 1000 : 5000
var pollRetries = config.poll_retries ? config.poll_retries : 1

var verbose = mh.isTrue(config.verbose)
var debug = mh.isTrue(config.debug)

var separators = ['_', '-', '$', ':', ';', '!', '@', '#', '%', '^', '~']
var slugSeparator = '_'

if (config.slug_separator) {
    if (!separators.includes(config.slug_separator)) {
        console.warn("Invalid slug separator: '%s'", config.slug_separator)
        process.exit(1)
    }
    slugSeparator = config.slug_separator
}
mh.setSeparator(slugSeparator)

if (mqttConf.cafile) mqttConf.cacertificate = [fs.readFileSync(mqttConf.cafile)]

// Last time an IP address responded
var ipTimestamps = {}

// Inventory of Rokus - Keyed by serial number
var rokus = {}
// IP address to serial number mapping
var rokuIps = {}
// Slug to serial number mapping
var rokuSlugs = {}

var newRokuRegex
var setRegex
var sendRegex

var mqttActivity = Date.now()

function expandRange(range) {
    var res

    if (typeof range === 'string') {
        if (range.match(/[^0-9\.]/)) {
            res = getIPRange(range)
            // If CIDR representation remove first and last addresses
            if (range.match(/\//)) {
                res.splice(0, 1)
                res.splice(-1, 1)
            }
        } else {
            res = [range]
        }
    } else if (typeof range === 'object') {
        res = getIPRange(range[0], range[1])
    }
    return res
}

var keyAliases = {}

function buildKeyAliases() {
    Object.keys(Keys).forEach((keyKey) => {
        var command = Keys[keyKey].command;

        // console.log([keyKey, Keys[keyKey].command, Keys[keyKey].name])
        // Map possible aliases

        [keyKey, command, Keys[keyKey].name].forEach((key) => {
            key = key.toLowerCase().replace(/[^a-z0-9]/g, '')
            keyAliases[key] = command
            // Additional aliases
            // InputHDMI1 => hdmi1, PowerOn => on, VolumeMute => mute
            key = key.replace(/^input/, '').replace(/^power/, '').replace(/^volumemute$/, 'mute')
            if (key.length) keyAliases[key] = command
        })
    })
    if (debug) console.log(util.inspect(keyAliases))
}

async function rokuActiveApp(info) {
    var client = info.client

    const xml = await client._getXml('query/active-app')
    if (info.debug) console.log('%s: %s', info.slug, util.inspect(xml).replace(/\s*\n\s*/g, ' '))
    return xml.activeApp
}

function rokuAppToString(app) {
    var appStr
    if (app.app === 'Roku') {
        appStr = 'Home'
        if ('screensaver' in app) {
            if (app.screensaver._) appStr = 'ScreenSaver: ' + app.screensaver._
        }
    } else {
        appStr = app.app._
    }
    return appStr
}

function rokuSetIdlePoll(info) {
    if ( verbose ) console.log('%s: setIdle', info.slug)
    info.pollInterval = pollIdle
    delete info.timer
    info.timer = setTimeout(rokuCheck, 500, info)

    if (info.pollResetTimer) delete info.pollResetTimer
}

function rokuSetActivePoll(info) {
    if ( verbose ) console.log('%s: setActive', info.slug)
    info.pollInterval = pollActive
    delete info.timer
    info.timer = setTimeout(rokuCheck, 500, info)

    if (info.pollResetTimer) delete info.pollResetTimer
    info.pollResetTimer = setTimeout(rokuSetIdlePoll, 60000, info)
}

function rokuCheck(info) {
    var client = info.client

    rokuActiveApp(info).then(function(app) {
            ipTimestamps[info.ip] = Date.now()
            info.connectTimeOuts = 0
            info.queryFails = 0
            var appStr = rokuAppToString(app)
            if (appStr !== info.app) {
                if (verbose) console.log("%s: changed app=\"%s\"", info.slug, appStr)
                info.app = appStr
                rokuAppPublish(info)
		if ( info.app === 'Roku' ) rokuSetActivePoll(info)
            }
            // If reported as on home screen check to see if device is still powered on
            if (info.supportsSuspend && app.app === 'Roku') {
                client.info().then(function(newInfo) {
                    if (info.powerMode !== newInfo.powerMode) {
                        info.powerMode = newInfo.powerMode
                        rokuStatePublish(info)
                    }
                }, function(err) {
                    console.warn("Error: %s(%s): %s", info.slug, info.ip, err.code)
                })
            }
            info.timer = setTimeout(rokuCheck, info.pollInterval, info)
        }, function(err) {
            if (info.debug) console.log("Error: %s(%s): %s", info.slug, info.ip, err.code)
            // Device has gone away - most likely lost power
            switch (err.code) {
                // No response
                case 'EHOSTUNREACH':
                    if (info.connectTimeOuts >= pollRetries) {
                        delete ipTimestamps[info.ip]
                        info.powerMode = 'PowerOff'
                        rokuStatePublish(info)
                    } else {
                        info.connectTimeOuts += 1
                        info.timer = setTimeout(rokuCheck, info.pollInterval, info)
                    }
                    break
                default:
                    // Edge case - Device is online but not responding to API requests
                    // Possibly because IP address has been reused
                    ipTimestamps[info.ip] = Date.now()
                    if (info.queryFails >= pollRetries) {
                        info.powerMode = 'Gone'
                        rokuStatePublish(info)
                        // info.timer = setTimeout(rokuCheck, info.pollInterval, info)
                    } else {
                        info.connectTimeOuts = 0
                        info.queryFails += 1
                    }
                    break
            }
        },
        function(err) {
            console.warn("Warn: %s(%s): %s", info.slug, info.ip, err.code)
        }
    )
}

function rokuStatePublish(info) {
    if (debug) console.log("%s: power state=%s", info.slug, info.powerMode)
    if (config.roku_state_topic) mqttClient.publish(util.format(config.roku_state_topic, info.slug), info.powerMode.toLowerCase().replace(/^power/, ''))
}

function rokuAppPublish(info) {
    if (debug) console.log("%s: publish app=\"%s\"", info.slug, info.app)
    if (config.roku_app_topic) mqttClient.publish(util.format(config.roku_app_topic, info.slug), info.app)
}

function rokuInfo(ip) {
    if (ipTimestamps[ip]) {
        // Don't check if checked recently - discover_expire defines time in config
        if ((Date.now() - ipTimestamps[ip]) < expireIpAfter) {
            if (debug) console.log("%s: checked recently", ip)
            return
        }
    }

    ipTimestamps[ip] = Date.now()

    const client = new RokuClient('http://' + ip + ':8060')
    client.info().then(function(info) {
        if (debug) console.log(info)
        info.ip = ip
        info.slug = info.userDeviceName.toSlug()
        info.client = client
        info.connectTimeOuts = 0
        info.queryFails = 0
        info.debug = debug
        info.pollInterval = pollIdle

	var existingRoku = rokus[info.serialNumber] ? true : false

        rokus[info.serialNumber] = info
        rokuIps[ip] = info.serialNumber
        rokuSlugs[info.slug] = info.serialNumber

        client.apps().then(function(apps) {
            for (let elem in apps) {
                apps[elem].slug = apps[elem].name.toSlug()
            }
            info.apps = apps
        })

        rokuActiveApp(info).then(function(app) {

            if (info.debug) console.log("%s: %s", info.slug, util.inspect(app).replace(/\s*\n\s*/g, ' '))

            info.app = rokuAppToString(app)

            console.log("%s: %s => %s => %s power: %s",
		    existingRoku ? 'Refresh' : 'Found', 
		    ip, info.friendlyDeviceName, info.slug, info.powerMode)
 	    if ( info.powerMode === 'PowerOn' ) rokuSetActivePoll(info)
            rokuStatePublish(info)
            rokuAppPublish(info)

            info.timer = setTimeout(rokuCheck, 5000, info)
        })
    }, function(err) {
        if (debug) console.log(util.inspect(err).replace(/\s*\n\s*/g, ' '))
        switch (err.code) {
            case 'EHOSTUNREACH':
                if (debug) console.log("Not online: %s ", ip)
                delete ipTimestamps[ip]
                break
            default:
                if (verbose) console.warn("Not a Roku: %s ", ip)
                break
        }
    })
}

function rokuFindApp(info, appName) {
    if (!info.apps) return
    var slug = appName.toSlug()
    for (let elem in info.apps) {
        if (slug === info.apps[elem].slug) return info.apps[elem].id
    }
}


function rokuSet(topic, payload) {
    var info
    var action

    if (debug) console.log("Topic: %s Payload: %s", topic, payload)

    payload = payload.toString()

    topic.split('/').forEach(function(word) {
        word = word.toLowerCase()
        if (rokuSlugs[word]) info = rokus[rokuSlugs[word]]
        action = word
    })
    if (action === 'scan') {
        setTimeout(rokuScanAll, 100)
        return
    }
    if (!info) {
        console.warn("Unexpected set message topic: %s payload: %s", topic, payload)
        return
    }
    if (verbose) console.log("%s: action=%s value=\"%s\"", info.slug, action, payload)
    switch (action) {
        case 'active':
            rokuSetActivePoll(info)
            break
        case 'debug':
            info.debug = mh.isTrue(payload)
            break
        case 'keypress':
            rokuKeypressSend(info, payload)
            rokuSetActivePoll(info)
            break
        case 'text':
            rokuTextSend(info, payload)
            rokuSetActivePoll(info)
            break
        case 'app':
            var appId = rokuFindApp(info, payload)
            if (appId) {
                info.pollInterval = pollActive
                info.client.launch(appId)
            }
            rokuSetActivePoll(info)
            break
    }
}

function rokuScanAll() {
    ipTimestamps = {}
    var delay = 50

    if (mh.isTrue(config.discover_upnp)) rokuDiscover()

    if (config.roku_ips) {
        config.roku_ips.forEach(function(range) {
            try {
                if (verbose) console.log("scan ips: %s", range)
                expandRange(range).forEach(function(ip) {
                    setTimeout(rokuInfo, delay, ip)
                    delay += 100
                })
            } catch (err) {
                console.warn('badly formed range: %s error: %s', range, util.inspect(err).replace(/\s*\n\s*/g, ' '))
            }
        })
    }
}

var ssdp_client

function rokuDiscover() {
    const node_ssdp = require("node-ssdp").Client

    ssdp_client = new node_ssdp({})

    ssdp_client.on('response', function inResponse(headers, code, rinfo) {
        if (headers.ST !== 'roku:ecp') return

        setTimeout(rokuInfo, 100, rinfo.address)
    })

    ssdp_client.search('roku:ecp')
    setTimeout(function() {
        ssdp_client.search('roku:ecp')
    }, 10000)
}

//
// Process MQTT messages informing of a (potential) new Roku online
function rokuAlive(topic, payload) {
    var ip

    if (config.new_roku_attribute) {
        var message
        try {
            message = JSON.parse(payload.toString())
            if (debug) console.log(topic + ': ' + util.inspect(message).replace(/\s*\n\s*/g, ' '))
            ip = message[config.new_roku_attribute]
        } catch {
            console.warn('badly formed message: ' + message.toString().replace(/\s*\n\s*/g, ' '))
            return
        }
    } else {
        ip = payload.toString()
    }
    if (verbose && (!ipTimestamps[ip])) console.log("Device online: %s", ip)
    // Allow time for device to stabilize
    setTimeout(rokuInfo, 5000, ip)
}

const safeCharRegex = /^[\x21-\x7E]$/

function rokuTextSend(info, payload) {
    if (verbose) console.log("%s: send text: %s", info.slug, payload)
    var text = payload.split('').map((char) => {
        return char.replace(' ', 'space')
    }).join(' ')
    rokuKeypressSend(info, text)
}

function rokuKeypressSend(info, payload) {
    if (verbose) console.log("%s: send keypress: %s", info.slug, payload)

    var client = info.client
    var chain = client.command()
    var err = false

    payload.split(' ').forEach(function(cmd) {
        var repeat = 1
        // Look for zzzzzz(999)
        var res = cmd.match(/^([^()]+)\(([\d.]+)\)$/)
        if (res) {
            cmd = res[1]
            repeat = res[2]
        }
        if (cmd.length > 1) {
            var cmdLower = cmd.toLowerCase().replace(/[^a-z0-9]/g, '')
            if (cmdLower === 'wait' || cmdLower === 'delay') {
                if (debug) console.log("%s: wait: %s", info.slug, repeat)
                chain.wait(repeat * 1000)
            } else if (cmdLower === 'space') {
                if (debug) console.log("%s: send char: %s * %s", info.slug, cmd, repeat)
                chain.keypress(' ', parseInt(repeat))
            } else if (keyAliases[cmdLower]) {
                if (debug) console.log("%s: send: %s * %s", info.slug, cmd, repeat)
                chain.keypress(keyAliases[cmdLower], parseInt(repeat))
            } else {
                console.warn("%s: unknown key: %s", info.slug, cmd)
                err = true
            }
        } else if (cmd.match(safeCharRegex)) {
            // Match printable ASCII chars
            if (debug) console.log("%s: send char: %s * %s", info.slug, cmd, repeat)
            chain.keypress(cmd, parseInt(repeat))
        } else {
            console.warn("%s: invalid key: %s", info.slug, util.inspect(cmd))
            err = true
        }
    })
    if (err) {
        console.warn("%s: invalid keypress string: %s", info.slug, util.inspect(payload))
    } else {
        chain.send().then().catch((err) => {
            console.warn("%s: %s", info.slug, util.inspect(err))
        })
    }
}

var mqttClient = mqtt.connect({
    ca: mqttConf.cacertificate,
    host: mqttConf.host,
    port: mqttConf.port,
    username: mqttConf.username,
    password: mqttConf.password,
    protocol: mqttConf.protocol,
    keepalive: mqttConf.keepalive,
    will: config.status_topic ? {
        topic: config.status_topic,
        payload: 'stop'
    } : undefined
})

mqttClient.on('connect', function() {
    console.log("Connected to MQTT Broker")

    if (config.new_roku_topic) {
        mqttClient.subscribe(config.new_roku_topic)
        newRokuRegex = mh.topicToRegex(config.new_roku_topic)
        if (debug) console.log('New Roku topic match: %s', newRokuRegex)
    }

    if (config.roku_set_topic) {
        mqttClient.subscribe(config.roku_set_topic + '/+')
        setRegex = mh.topicToRegex(config.roku_set_topic)
        if (debug) console.log('Set topic match: %s', setRegex)
    }
    if (config.roku_send_topic) {
        mqttClient.subscribe(config.roku_send_topic + '/+')
        sendRegex = mh.topicToRegex(config.roku_send_topic)
        if (debug) console.log('Send topic match: %s', sendRegex)
    }

    mqttClient.subscribe(mqttConf.ping_topic)
})

mqttClient.on('close', function() {
    console.warn("MQTT connection closed")
    process.exit(1)
})

mqttClient.on('error', function(err) {
    console.warn(err)
    //process.exit(1)
})

// MQTT Keepalive
setInterval(function() {
    mqttClient.publish(mqttConf.ping_topic, JSON.stringify({
        timestamp: new Date()
    }))
}, 60000)

mqttClient.on('message', function(topic, payload) {
    mqttActivity = Date.now()

    payload = payload.toString()

    if (topic === mqttConf.ping_topic) {
        return
    } else if (setRegex && topic.match(setRegex)) {
        rokuSet(topic, payload)
    } else if (sendRegex && topic.match(sendRegex)) {
        rokuSet(topic, payload)
    } else if (newRokuRegex && topic.match(newRokuRegex)) {
        rokuAlive(topic, payload)
    } else {
        console.warn("Unexpected message: %s : %s", topic, payload)
    }
})

setInterval(function() {
    var mqttLast = (Date.now() - mqttActivity)
    if (mqttLast >= 90000) {
        console.warn("Exit due to MQTT inactivity")
        process.exit(10)
    }
}, 10000)

buildKeyAliases()

if (config.status_topic) mqttClient.publish(config.status_topic, 'start')

setTimeout(rokuScanAll, 100)

if (debug) {
    setTimeout(function() {
        console.log(util.inspect(rokus))
    }, 30000)
}

console.log("Starting")
