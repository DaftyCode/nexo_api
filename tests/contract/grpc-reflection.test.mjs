// Contract tests for gRPC server reflection, v1 and v1alpha, without pasting a proto.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { FileDescriptorProto } = require('protobufjs/ext/descriptor');

const reflectionProto = (version) => `syntax = "proto3";
package grpc.reflection.${version};
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }`;

/** Descriptors as protoc writes them: qualified type names and the files each one imports. */
const descriptors = new Map(
  [
    {
      name: 'common.proto',
      package: 'fixture',
      syntax: 'proto3',
      messageType: [
        {
          name: 'Person',
          field: [{ name: 'name', number: 1, label: 1, type: 9, jsonName: 'name' }],
        },
      ],
    },
    {
      name: 'fixture.proto',
      package: 'fixture',
      syntax: 'proto3',
      dependency: ['common.proto', 'google/protobuf/timestamp.proto'],
      messageType: [
        {
          name: 'Request',
          field: [
            {
              name: 'person',
              number: 1,
              label: 1,
              type: 11,
              typeName: '.fixture.Person',
              jsonName: 'person',
            },
            { name: 'times', number: 2, label: 1, type: 3, jsonName: 'times' },
            {
              name: 'at',
              number: 3,
              label: 1,
              type: 11,
              typeName: '.google.protobuf.Timestamp',
              jsonName: 'at',
            },
          ],
        },
        {
          name: 'Response',
          field: [{ name: 'greeting', number: 1, label: 1, type: 9, jsonName: 'greeting' }],
        },
      ],
      service: [
        {
          name: 'Echo',
          method: [
            { name: 'Say', inputType: '.fixture.Request', outputType: '.fixture.Response' },
            {
              name: 'Count',
              inputType: '.fixture.Request',
              outputType: '.fixture.Response',
              serverStreaming: true,
            },
          ],
        },
      ],
    },
  ].map((file) => [
    file.name,
    Buffer.from(FileDescriptorProto.encode(FileDescriptorProto.fromObject(file)).finish()),
  ]),
);

let server;
let directory;
before(async () => {
  server = await startServer();
  directory = await mkdtemp(join(tmpdir(), 'nexo-reflection-'));
  await writeFile(
    join(directory, 'common.proto'),
    `syntax = "proto3"; package fixture; message Person { string name = 1; }`,
  );
  await writeFile(
    join(directory, 'fixture.proto'),
    `syntax = "proto3"; package fixture;
import "common.proto";
import "google/protobuf/timestamp.proto";
service Echo { rpc Say (Request) returns (Response); rpc Count (Request) returns (stream Response); }
message Request { Person person = 1; int64 times = 2; google.protobuf.Timestamp at = 3; }
message Response { string greeting = 1; }`,
  );
  for (const version of ['v1', 'v1alpha'])
    await writeFile(join(directory, `reflection-${version}.proto`), reflectionProto(version));
});
after(async () => {
  await server?.stop();
  await rm(directory, { recursive: true, force: true });
});

/**
 * A server with the Echo service and reflection of one version. Reflection answers each file
 * alone, and does not know the well-known types, so the client must ask for the rest.
 */
async function reflectingServer(version) {
  const options = { keepCase: true, longs: String, defaults: false, oneofs: true };
  const echo = loader.loadSync(join(directory, 'fixture.proto'), { includeDirs: [directory] });
  const reflection = grpc.loadPackageDefinition(
    loader.loadSync(join(directory, `reflection-${version}.proto`), options),
  ).grpc.reflection[version].ServerReflection;
  const asked = [];
  const authorizations = [];
  const grpcServer = new grpc.Server();
  grpcServer.addService(grpc.loadPackageDefinition(echo).fixture.Echo.service, {
    Say(call, callback) {
      callback(null, { greeting: `Hello ${call.request.person?.name}` });
    },
    Count(call) {
      for (let i = 0; i < Number(call.request.times); i++) call.write({ greeting: `${i}` });
      call.end();
    },
  });
  grpcServer.addService(reflection.service, {
    ServerReflectionInfo(call) {
      authorizations.push(call.metadata.get('authorization')[0]);
      call.on('data', (request) => {
        asked.push(request.message_request);
        const file = (name) =>
          descriptors.has(name)
            ? { file_descriptor_response: { file_descriptor_proto: [descriptors.get(name)] } }
            : { error_response: { error_code: 5, error_message: `${name} not found` } };
        if (request.message_request === 'list_services')
          call.write({
            list_services_response: {
              service: [
                { name: 'fixture.Echo' },
                { name: `grpc.reflection.${version}.ServerReflection` },
              ],
            },
          });
        else if (request.file_containing_symbol === 'fixture.Echo')
          call.write(file('fixture.proto'));
        else if (request.message_request === 'file_by_filename')
          call.write(file(request.file_by_filename));
        else call.write(file('unknown'));
      });
      call.on('end', () => call.end());
    },
  });
  const port = await new Promise((resolve, reject) =>
    grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  return {
    url: `127.0.0.1:${port}`,
    asked,
    authorizations,
    close: () => grpcServer.forceShutdown(),
  };
}

for (const version of ['v1', 'v1alpha']) {
  test(`reflection ${version}: services are listed and called without a proto`, async () => {
    const fixture = await reflectingServer(version);
    try {
      const listed = await server.execute('grpc', {
        url: fixture.url,
        reflection: true,
        metadata: [{ key: 'authorization', value: 'Bearer t', enabled: true }],
      });
      // The metadata goes with every reflection question, as with calls.
      assert.ok(fixture.authorizations.every((value) => value === 'Bearer t'));
      assert.equal(listed.reflection, version);
      assert.deepEqual(listed.services, ['fixture.Echo']);
      assert.deepEqual(
        listed.methods['fixture.Echo'].map((method) => [method.name, method.serverStreaming]),
        [
          ['Say', false],
          ['Count', true],
        ],
      );
      // The imports were asked for by name; the well-known type came from the engine.
      assert.ok(fixture.asked.includes('file_by_filename'));

      const unary = await server.execute('grpc', {
        url: fixture.url,
        reflection: true,
        service: 'fixture.Echo',
        method: 'Say',
        message: { person: { name: 'Nexo' }, at: '2026-11-09T10:00:00Z' },
      });
      assert.equal(unary.message.greeting, 'Hello Nexo');
      const stream = await server.execute('grpc', {
        url: fixture.url,
        reflection: true,
        service: 'fixture.Echo',
        method: 'Count',
        message: { times: 3 },
      });
      assert.deepEqual(
        stream.messages.map((message) => message.greeting),
        ['0', '1', '2'],
      );
      await assert.rejects(
        server.execute('grpc', {
          url: fixture.url,
          reflection: true,
          service: 'fixture.Missing',
          method: 'Say',
        }),
        /does not offer fixture\.Missing\. Available: fixture\.Echo/,
      );
    } finally {
      fixture.close();
    }
  });
}

test('a server without reflection says so', async () => {
  const grpcServer = new grpc.Server();
  const port = await new Promise((resolve, reject) =>
    grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  try {
    await assert.rejects(
      server.execute('grpc', { url: `127.0.0.1:${port}`, reflection: true }),
      /does not offer reflection/,
    );
    await assert.rejects(server.execute('grpc', { reflection: true }), /server address/);
  } finally {
    grpcServer.forceShutdown();
  }
});
