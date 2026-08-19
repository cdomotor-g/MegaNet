#!/usr/bin/env node
// publish-sample.js — A test client, for proving the whole path end to end.
//
//   npm run publish-sample -- --station loudoun_br_al --alert-id 6128
//
// Publishes one reading and a retained status, with a Last Will and Testament,
// using the same credentials a real logger would. It exists so that "a test
// client publishing to meganet/v1/… results in a row within seconds" is a thing
// somebody can *do* rather than a claim in a ticket — and so that a station
// commissioned in the field can be checked from a laptop before anyone drives
// home.
//
// Reads MQTT_URL, MQTT_USERNAME and MQTT_PASSWORD from the environment like the
// bridge does. Use the *station's* credentials, not the bridge's: publishing
// successfully with them is the proof that the ACL is right.

const mqtt = require('mqtt');
const { readingTopic, statusTopic } = require('../src/topics');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const station = arg('station');
  if (!station) {
    process.stderr.write(
      'usage: node tools/publish-sample.js --station <bureau number> [--device logger]\n' +
      '                                    [--alert-id 6128 | --station-number 541155 --channel rain]\n' +
      '                                    [--value 42] [--offline]\n');
    process.exit(2);
  }

  const device = arg('device', 'logger');
  const url = process.env.MQTT_URL;
  if (!url) {
    process.stderr.write('MQTT_URL is not set — see bridge/.env.example\n');
    process.exit(2);
  }

  const reading = {
    reading_ts: new Date().toISOString(),
    value_raw: Number(arg('value', 1)),
  };
  if (arg('alert-id')) reading.alert_id = Number(arg('alert-id'));
  if (arg('station-number')) reading.station_number = arg('station-number');
  if (arg('channel')) reading.channel = arg('channel');
  if (!reading.alert_id && !reading.station_number) {
    process.stderr.write('give it an --alert-id, or a --station-number and --channel\n');
    process.exit(2);
  }

  const client = await mqtt.connectAsync(url, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: `sample-${station}-${process.pid}`,
    clean: true,
    reconnectPeriod: 0,
    // The same will a real logger sets, so the LWT path is exercised too: kill
    // this process with SIGKILL rather than Ctrl-C and the station should show
    // as offline within seconds.
    will: {
      topic: statusTopic(station),
      payload: JSON.stringify({ online: false }),
      qos: 1,
      retain: true,
    },
  });
  console.log(`connected to ${url.replace(/(\w+:\/\/[^/\s:@]+):[^/\s@]*@/, '$1:***@')}`);

  await client.publishAsync(
    statusTopic(station),
    JSON.stringify({ online: !process.argv.includes('--offline'), by: 'publish-sample' }),
    { qos: 1, retain: true },
  );
  console.log(`published ${statusTopic(station)}`);

  await client.publishAsync(readingTopic(station, device), JSON.stringify(reading), { qos: 1 });
  console.log(`published ${readingTopic(station, device)} ${JSON.stringify(reading)}`);

  await client.endAsync();
  console.log('\nNow check it landed:\n'
    + "  select * from meganet.reading order by received_at desc limit 5;\n"
    + `  select * from meganet.station_health where station_key = '${station}';`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
