import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

const MAX_SERVICE_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(`Cross-device evidence failed: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object.`);
  return value;
}

function exactString(value, label, maximum = 2048) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) fail(`${label} is invalid.`);
  return value;
}

function exactInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid.`);
  return value;
}

function exactArray(value, label, maximum = 1024) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} is invalid.`);
  return value;
}

function verifyServiceEvidence(value, recoveredSha256, recoveredSize) {
  const evidence = object(value, "Service evidence");
  if (evidence.schema !== "wildbloom-cross-device-service-evidence-v1") fail("the service-evidence schema is unsupported.");
  exactString(evidence.sessionId, "Session ID", 64);
  if (evidence.status !== "closed") fail("the coordinator was not closed cleanly.");
  exactString(evidence.startedAt, "Start time", 64);
  exactString(evidence.endedAt, "End time", 64);
  if (Number.isNaN(Date.parse(evidence.startedAt)) || Number.isNaN(Date.parse(evidence.endedAt))) fail("service times are invalid.");
  const source = object(evidence.source, "Source");
  if (!HEX_40.test(source.commit) || source.clean !== true) fail("the coordinator did not run from one exact clean commit.");
  const origin = new URL(exactString(evidence.publicOrigin, "Public origin"));
  if (origin.protocol !== "https:" || isIP(origin.hostname) !== 0 || origin.pathname !== "/" || origin.search || origin.hash) {
    fail("the public origin is not an exact HTTPS hostname.");
  }
  const errors = exactArray(evidence.errors, "Service errors", 32);
  if (errors.length !== 0) fail(`controlled services recorded errors: ${errors.join("; ")}`);

  const fixture = object(evidence.fixture, "Fixture");
  if (!HEX_64.test(fixture.sha256)) fail("the fixture hash is invalid.");
  const fixtureSize = exactInteger(fixture.size, "Fixture size", 1);
  if (recoveredSha256 !== fixture.sha256 || recoveredSize !== fixtureSize) {
    fail("the independently hashed recovered file does not equal the exact public fixture.");
  }
  const fixtureEndpoints = exactArray(fixture.fetchEndpointIds, "Fixture endpoint list", 2);
  if (fixtureEndpoints.length !== 1) fail("exactly one device must fetch the plaintext fixture.");
  const publisherEndpoint = exactString(fixtureEndpoints[0], "Publisher endpoint", 64);

  const blossom = object(evidence.blossom, "Blossom evidence");
  const uploads = exactArray(blossom.uploads, "Blossom uploads", 4);
  if (uploads.length !== 1) fail("the ceremony must contain exactly one encrypted Blossom upload.");
  const upload = object(uploads[0], "Blossom upload");
  if (upload.endpointId !== publisherEndpoint) fail("the fixture device did not perform the upload.");
  if (!HEX_64.test(upload.sha256) || exactInteger(upload.size, "Upload size", 1) <= fixtureSize) {
    fail("the encrypted upload facts are invalid.");
  }
  if (
    upload.sourceBytesExposed !== false
    || (upload.mimeType !== "application/vnd.forgesworn.encrypted"
      && upload.mimeType !== "application/vnd.wildbloom.encrypted")
  ) {
    fail("the upload did not retain Wildbloom's encrypted-envelope boundary.");
  }
  if (exactInteger(blossom.bytesServed, "Blossom bytes served") !== 0) fail("Blossom served blob bytes during the peer ceremony.");
  exactInteger(blossom.retrievalAttempts, "Blossom retrieval attempts");
  const authorisation = object(upload.authorisation, "Blossom authorisation");
  if (
    !HEX_64.test(authorisation.eventId)
    || !HEX_64.test(authorisation.pubkey)
    || authorisation.exactHostAndHash !== true
    || authorisation.signatureValid !== true
    || exactInteger(authorisation.lifetimeSeconds, "Authorisation lifetime", 30) > 300
  ) {
    fail("Blossom authorisation was not valid, short-lived and exact-host/hash scoped.");
  }

  const relay = object(evidence.relay, "Relay evidence");
  const publications = exactArray(relay.publications, "Relay publications", 8);
  const fileEvents = publications.filter((entry) => entry?.kind === 1063);
  const torrentEvents = publications.filter((entry) => entry?.kind === 2003);
  if (fileEvents.length !== 1 || torrentEvents.length !== 1 || publications.length !== 2) {
    fail("the relay did not receive exactly one NIP-94 and one NIP-35 event.");
  }
  const fileEvent = object(fileEvents[0], "NIP-94 publication");
  const torrentEvent = object(torrentEvents[0], "NIP-35 publication");
  if (
    !HEX_64.test(fileEvent.id)
    || !HEX_64.test(torrentEvent.id)
    || fileEvent.endpointId !== publisherEndpoint
    || torrentEvent.endpointId !== publisherEndpoint
    || fileEvent.pubkey !== authorisation.pubkey
    || torrentEvent.pubkey !== fileEvent.pubkey
    || fileEvent.blobHash !== upload.sha256
    || !HEX_40.test(fileEvent.infoHash)
    || torrentEvent.infoHash !== fileEvent.infoHash
  ) {
    fail("the signed NIP-94, NIP-35, upload and publisher facts do not agree.");
  }
  const lookups = exactArray(relay.lookups, "Relay lookups", 32);
  const downloaderLookups = lookups.filter((entry) => entry?.eventId === fileEvent.id && entry?.exactId === true && entry?.endpointId !== publisherEndpoint);
  if (downloaderLookups.length === 0) fail("a second device did not resolve the NIP-94 event by exact ID.");
  const downloaderEndpoint = exactString(downloaderLookups[0].endpointId, "Downloader endpoint", 64);
  if (lookups.some((entry) => entry?.eventId === fileEvent.id && entry?.endpointId === publisherEndpoint)) {
    fail("the publisher also performed the recorded retrieval lookup; use a clean two-role ceremony.");
  }

  const tracker = object(evidence.tracker, "Tracker evidence");
  const swarms = object(tracker.swarms, "Tracker swarms");
  const swarm = object(swarms[fileEvent.infoHash], "Exact tracker swarm");
  const endpointIds = exactArray(swarm.endpointIds, "Swarm endpoint list", 8);
  if (!endpointIds.includes(publisherEndpoint) || !endpointIds.includes(downloaderEndpoint) || endpointIds.length !== 2) {
    fail("the exact torrent swarm did not contain only the publisher and downloader devices.");
  }
  if (exactInteger(swarm.peakConcurrentEndpoints, "Peak concurrent tracker endpoints", 1) < 2) {
    fail("the tracker never observed both devices concurrently.");
  }
  if (exactArray(swarm.currentEndpointIds, "Final tracker endpoint list", 8).length !== 0) {
    fail("a peer remained active when the coordinator stopped.");
  }
  const announcements = object(swarm.announcementCounts, "Tracker announcement counts");
  if (exactInteger(announcements.started, "Tracker starts") < 2) fail("the tracker did not receive both peer starts.");

  return {
    sessionId: evidence.sessionId,
    sourceCommit: source.commit,
    publicOrigin: origin.origin,
    fixture: { sha256: fixture.sha256, size: fixtureSize },
    encryptedBlob: { sha256: upload.sha256, size: upload.size },
    eventIds: { nip94: fileEvent.id, nip35: torrentEvent.id },
    infoHash: fileEvent.infoHash,
    endpointAliases: { publisher: publisherEndpoint, downloader: downloaderEndpoint },
    blossomRetrievalAttempts: blossom.retrievalAttempts,
    trackerPeakConcurrentEndpoints: swarm.peakConcurrentEndpoints,
  };
}

function parseTcpdump(text) {
  const packets = [];
  const ignored = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^(\d+(?:\.\d+)?) IP (\d+\.\d+\.\d+\.\d+)\.(\d+) > (\d+\.\d+\.\d+\.\d+)\.(\d+): (.+)$/u.exec(line);
    if (!match) {
      ignored.push(line);
      continue;
    }
    const detail = match[6];
    const protocol = detail.startsWith("UDP") ? "udp" : detail.startsWith("tcp") ? "tcp" : "other";
    packets.push({
      timestamp: Number(match[1]),
      source: match[2],
      sourcePort: Number(match[3]),
      destination: match[4],
      destinationPort: Number(match[5]),
      protocol,
    });
  }
  return { packets, ignored };
}

function classifyCapture(parsed, network) {
  const counts = {
    publisherToCoordinator: 0,
    downloaderToCoordinator: 0,
    peerUdp: 0,
    peerTcp: 0,
    dns: 0,
    mdns: 0,
    arpOrNonIp: 0,
  };
  const endpoints = new Set([network.publisherIp, network.downloaderIp]);
  const unapproved = [];
  for (const line of parsed.ignored) {
    if (/\bIP6?\b/u.test(line)) unapproved.push("unparsed IP packet");
    else counts.arpOrNonIp += 1;
  }
  for (const packet of parsed.packets) {
    const sourceIsDevice = endpoints.has(packet.source);
    const destinationIsDevice = endpoints.has(packet.destination);
    if (!sourceIsDevice && !destinationIsDevice) continue;
    const isPeer = (packet.source === network.publisherIp && packet.destination === network.downloaderIp)
      || (packet.source === network.downloaderIp && packet.destination === network.publisherIp);
    if (isPeer) {
      if (packet.protocol === "udp") counts.peerUdp += 1;
      else if (packet.protocol === "tcp") counts.peerTcp += 1;
      else unapproved.push("non-TCP/UDP direct peer packet");
      continue;
    }
    const device = sourceIsDevice ? packet.source : packet.destination;
    const other = sourceIsDevice ? packet.destination : packet.source;
    const otherPort = sourceIsDevice ? packet.destinationPort : packet.sourcePort;
    if (other === network.coordinatorIp && otherPort === network.coordinatorPort && packet.protocol === "tcp") {
      if (device === network.publisherIp) counts.publisherToCoordinator += 1;
      else counts.downloaderToCoordinator += 1;
      continue;
    }
    if (network.dnsIps.has(other) && otherPort === 53 && (packet.protocol === "udp" || packet.protocol === "tcp")) {
      counts.dns += 1;
      continue;
    }
    if (
      ((packet.destination === "224.0.0.251" && packet.destinationPort === 5353)
        || (packet.source === "224.0.0.251" && packet.sourcePort === 5353))
      && packet.protocol === "udp"
    ) {
      counts.mdns += 1;
      continue;
    }
    unapproved.push(`${packet.protocol} flow to an undeclared endpoint`);
  }
  if (counts.publisherToCoordinator === 0 || counts.downloaderToCoordinator === 0) {
    fail("the capture does not show both devices using the exact HTTPS/WSS coordinator.");
  }
  if (counts.peerUdp === 0) fail("the capture contains no direct publisher-to-downloader UDP/WebRTC traffic.");
  if (unapproved.length > 0) fail(`the isolated capture contains ${unapproved.length} undeclared or unparsed device flows.`);
  return counts;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--self-test") return { selfTest: true };
  const singles = new Set([
    "--service-evidence", "--capture", "--publisher-ip", "--downloader-ip",
    "--coordinator-ip", "--coordinator-port", "--recovered-sha256", "--recovered-size", "--output",
  ]);
  const values = { dnsIps: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--dns-ip" && !singles.has(argument)) throw new Error(`Unknown evidence argument: ${argument}`);
    if (argument !== "--dns-ip" && seen.has(argument)) throw new Error(`${argument} may be supplied only once.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--dns-ip") values.dnsIps.push(value);
    else {
      seen.add(argument);
      values[argument.slice(2)] = value;
    }
    index += 1;
  }
  for (const argument of singles) {
    const name = argument.slice(2);
    if (!values[name]) throw new Error(`${argument} is required.`);
  }
  const ips = [values["publisher-ip"], values["downloader-ip"], values["coordinator-ip"], ...values.dnsIps];
  if (ips.some((ip) => isIP(ip) !== 4)) throw new Error("This evidence format currently accepts exact IPv4 addresses only.");
  if (new Set(ips.slice(0, 3)).size !== 3) throw new Error("Publisher, downloader and coordinator addresses must differ.");
  if (!/^[0-9]{1,5}$/u.test(values["coordinator-port"])) throw new Error("Coordinator port is invalid.");
  const coordinatorPort = Number(values["coordinator-port"]);
  if (coordinatorPort < 1 || coordinatorPort > 65_535) throw new Error("Coordinator port is invalid.");
  if (!HEX_64.test(values["recovered-sha256"])) throw new Error("Recovered SHA-256 must be 64 lowercase hex characters.");
  if (!/^[0-9]{1,12}$/u.test(values["recovered-size"])) throw new Error("Recovered size is invalid.");
  const recoveredSize = Number(values["recovered-size"]);
  if (!Number.isSafeInteger(recoveredSize) || recoveredSize < 1) throw new Error("Recovered size is invalid.");
  return {
    serviceEvidencePath: resolve(values["service-evidence"]),
    capturePath: resolve(values.capture),
    outputPath: resolve(values.output),
    recoveredSha256: values["recovered-sha256"],
    recoveredSize,
    network: {
      publisherIp: values["publisher-ip"],
      downloaderIp: values["downloader-ip"],
      coordinatorIp: values["coordinator-ip"],
      coordinatorPort,
      dnsIps: new Set(values.dnsIps),
    },
  };
}

function boundedRegularFile(path, maximum, label) {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 1 || details.size > maximum) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  return details;
}

function selfTest() {
  const publisher = "endpoint-publisher";
  const downloader = "endpoint-downloader";
  const fixtureHash = "1".repeat(64);
  const blobHash = "2".repeat(64);
  const fileId = "3".repeat(64);
  const torrentId = "4".repeat(64);
  const pubkey = "5".repeat(64);
  const infoHash = "6".repeat(40);
  const evidence = {
    schema: "wildbloom-cross-device-service-evidence-v1",
    sessionId: "self-test",
    status: "closed",
    startedAt: "2026-08-30T10:00:00.000Z",
    endedAt: "2026-08-30T10:10:00.000Z",
    source: { commit: "a".repeat(40), clean: true },
    publicOrigin: "https://wildbloom-test.example",
    fixture: { sha256: fixtureHash, size: 524288, fetchEndpointIds: [publisher] },
    blossom: {
      uploads: [{
        endpointId: publisher,
        sha256: blobHash,
        size: 530000,
        mimeType: "application/vnd.forgesworn.encrypted",
        sourceBytesExposed: false,
        authorisation: {
          eventId: "7".repeat(64), pubkey, lifetimeSeconds: 90, exactHostAndHash: true, signatureValid: true,
        },
      }],
      retrievalAttempts: 1,
      bytesServed: 0,
    },
    relay: {
      publications: [
        { id: fileId, kind: 1063, pubkey, endpointId: publisher, blobHash, infoHash },
        { id: torrentId, kind: 2003, pubkey, endpointId: publisher, infoHash },
      ],
      lookups: [{ eventId: fileId, endpointId: downloader, exactId: true }],
    },
    tracker: {
      swarms: {
        [infoHash]: {
          endpointIds: [publisher, downloader],
          announcementCounts: { started: 2, stopped: 2, completed: 1, update: 3 },
          peakConcurrentEndpoints: 2,
          currentEndpointIds: [],
        },
      },
    },
    errors: [],
  };
  verifyServiceEvidence(evidence, fixtureHash, 524288);
  const captureText = [
    "1700000000.000001 IP 192.0.2.10.50000 > 192.0.2.12.443: tcp 0",
    "1700000000.000002 IP 192.0.2.12.443 > 192.0.2.10.50000: tcp 0",
    "1700000000.000003 IP 192.0.2.11.50001 > 192.0.2.12.443: tcp 0",
    "1700000000.000004 IP 192.0.2.10.60000 > 192.0.2.11.60001: UDP, length 1200",
    "1700000000.000005 ARP, Request who-has 192.0.2.11 tell 192.0.2.10, length 28",
  ].join("\n");
  const parsed = parseTcpdump(captureText);
  const counts = classifyCapture(parsed, {
    publisherIp: "192.0.2.10",
    downloaderIp: "192.0.2.11",
    coordinatorIp: "192.0.2.12",
    coordinatorPort: 443,
    dnsIps: new Set(),
  });
  if (counts.peerUdp !== 1 || counts.arpOrNonIp !== 1) fail("packet parser self-test returned unexpected counts.");
  let rejectedUndeclaredFlow = false;
  try {
    classifyCapture(parseTcpdump(`${captureText}\n1700000000.000006 IP 192.0.2.10.50002 > 198.51.100.20.3478: UDP, length 80`), {
      publisherIp: "192.0.2.10",
      downloaderIp: "192.0.2.11",
      coordinatorIp: "192.0.2.12",
      coordinatorPort: 443,
      dnsIps: new Set(),
    });
  } catch {
    rejectedUndeclaredFlow = true;
  }
  if (!rejectedUndeclaredFlow) fail("packet parser self-test accepted an undeclared STUN endpoint.");
  process.stdout.write("Cross-device evidence self-test passed.\n");
}

const options = parseArguments(process.argv.slice(2));
if (options.selfTest) {
  selfTest();
} else {
  if (existsSync(options.outputPath)) throw new Error(`Refusing to overwrite existing evidence: ${options.outputPath}`);
  const serviceDetails = boundedRegularFile(options.serviceEvidencePath, MAX_SERVICE_EVIDENCE_BYTES, "Service evidence");
  const captureDetails = boundedRegularFile(options.capturePath, MAX_CAPTURE_BYTES, "Packet capture");
  const serviceBytes = readFileSync(options.serviceEvidencePath);
  const serviceFacts = verifyServiceEvidence(JSON.parse(serviceBytes.toString("utf8")), options.recoveredSha256, options.recoveredSize);
  let decodedCapture;
  try {
    decodedCapture = execFileSync("tcpdump", ["-nn", "-tt", "-q", "-r", options.capturePath], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not decode the packet capture with tcpdump: ${diagnostic}`);
  }
  const packetCounts = classifyCapture(parseTcpdump(decodedCapture), options.network);
  const finalEvidence = {
    schema: "wildbloom-cross-device-acceptance-v1",
    status: "passed",
    verifiedAt: new Date().toISOString(),
    sourceCommit: serviceFacts.sourceCommit,
    sessionId: serviceFacts.sessionId,
    publicOrigin: serviceFacts.publicOrigin,
    fixture: serviceFacts.fixture,
    recoveredFile: { sha256: options.recoveredSha256, size: options.recoveredSize },
    encryptedBlob: serviceFacts.encryptedBlob,
    eventIds: serviceFacts.eventIds,
    infoHash: serviceFacts.infoHash,
    endpointAliases: { publisher: "publisher", downloader: "downloader", coordinator: "coordinator" },
    serviceEvidence: { sha256: sha256(serviceBytes), size: serviceDetails.size },
    packetCapture: { sha256: sha256(readFileSync(options.capturePath)), size: captureDetails.size, packetCounts },
    assertions: {
      exactCleanCommit: true,
      exactEncryptedUpload: true,
      blossomBlobBytesServed: 0,
      blossomRetrievalAttempts: serviceFacts.blossomRetrievalAttempts,
      validSignedNip94AndNip35: true,
      exactIdLookupFromSecondDevice: true,
      trackerPeakConcurrentEndpoints: serviceFacts.trackerPeakConcurrentEndpoints,
      directPeerUdpObserved: true,
      undeclaredDeviceFlowsObserved: 0,
      recoveredFixtureMatches: true,
      rawNetworkAddressesRetained: false,
    },
  };
  writeFileSync(options.outputPath, `${JSON.stringify(finalEvidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`Cross-device acceptance passed; redacted evidence written to ${options.outputPath}\n`);
}
