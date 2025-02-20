/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { configureClientMock } from './cluster_client.test.mocks';
import { loggingSystemMock } from '../../logging/logging_system.mock';
import { httpServerMock } from '../../http/http_server.mocks';
import { GetAuthHeaders } from '../../http';
import { elasticsearchClientMock } from './mocks';
import { ClusterClient } from './cluster_client';
import { ElasticsearchClientConfig } from './client_config';
import { DEFAULT_HEADERS } from '../default_headers';

const createConfig = (
  parts: Partial<ElasticsearchClientConfig> = {}
): ElasticsearchClientConfig => {
  return {
    sniffOnStart: false,
    sniffOnConnectionFault: false,
    sniffInterval: false,
    requestHeadersWhitelist: ['authorization'],
    customHeaders: {},
    hosts: ['http://localhost'],
    ...parts,
  };
};

describe('ClusterClient', () => {
  let logger: ReturnType<typeof loggingSystemMock.createLogger>;
  let getAuthHeaders: jest.MockedFunction<GetAuthHeaders>;
  let internalClient: ReturnType<typeof elasticsearchClientMock.createInternalClient>;
  let scopedClient: ReturnType<typeof elasticsearchClientMock.createInternalClient>;

  beforeEach(() => {
    logger = loggingSystemMock.createLogger();
    internalClient = elasticsearchClientMock.createInternalClient();
    scopedClient = elasticsearchClientMock.createInternalClient();
    getAuthHeaders = jest.fn().mockImplementation(() => ({
      authorization: 'auth',
      foo: 'bar',
    }));

    configureClientMock.mockImplementation((config, { scoped = false }) => {
      return scoped ? scopedClient : internalClient;
    });
  });

  afterEach(() => {
    configureClientMock.mockReset();
  });

  it('creates a single internal and scoped client during initialization', () => {
    const config = createConfig();
    const getExecutionContextMock = jest.fn();
    new ClusterClient(config, logger, 'custom-type', getAuthHeaders, getExecutionContextMock);

    expect(configureClientMock).toHaveBeenCalledTimes(2);
    expect(configureClientMock).toHaveBeenCalledWith(config, {
      logger,
      type: 'custom-type',
      getExecutionContext: getExecutionContextMock,
    });
    expect(configureClientMock).toHaveBeenCalledWith(config, {
      logger,
      type: 'custom-type',
      getExecutionContext: getExecutionContextMock,
      scoped: true,
    });
  });

  describe('#asInternalUser', () => {
    it('returns the internal client', () => {
      const clusterClient = new ClusterClient(
        createConfig(),
        logger,
        'custom-type',
        getAuthHeaders
      );

      expect(clusterClient.asInternalUser).toBe(internalClient);
    });
  });

  describe('#asScoped', () => {
    it('returns a scoped cluster client bound to the request', () => {
      const clusterClient = new ClusterClient(
        createConfig(),
        logger,
        'custom-type',
        getAuthHeaders
      );
      const request = httpServerMock.createKibanaRequest();

      const scopedClusterClient = clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({ headers: expect.any(Object) });

      expect(scopedClusterClient.asInternalUser).toBe(clusterClient.asInternalUser);
      expect(scopedClusterClient.asCurrentUser).toBe(scopedClient.child.mock.results[0].value);
    });

    it('returns a distinct scoped cluster client on each call', () => {
      const clusterClient = new ClusterClient(
        createConfig(),
        logger,
        'custom-type',
        getAuthHeaders
      );
      const request = httpServerMock.createKibanaRequest();

      const scopedClusterClient1 = clusterClient.asScoped(request);
      const scopedClusterClient2 = clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(2);

      expect(scopedClusterClient1).not.toBe(scopedClusterClient2);
      expect(scopedClusterClient1.asInternalUser).toBe(scopedClusterClient2.asInternalUser);
    });

    it('creates a scoped client with filtered request headers', () => {
      const config = createConfig({
        requestHeadersWhitelist: ['foo'],
      });
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({
        headers: {
          foo: 'bar',
          hello: 'dolly',
        },
      });

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: { ...DEFAULT_HEADERS, foo: 'bar', 'x-opaque-id': expect.any(String) },
      });
    });

    it('does not filter auth headers', () => {
      const config = createConfig({
        requestHeadersWhitelist: ['authorization'],
      });
      getAuthHeaders.mockReturnValue({
        authorization: 'auth',
        other: 'yep',
      });

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({});

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          ...DEFAULT_HEADERS,
          authorization: 'auth',
          other: 'yep',
          'x-opaque-id': expect.any(String),
        },
      });
    });

    it('respects auth headers precedence', () => {
      const config = createConfig({
        requestHeadersWhitelist: ['authorization'],
      });
      getAuthHeaders.mockReturnValue({
        authorization: 'auth',
        other: 'yep',
      });

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({
        headers: {
          authorization: 'override',
        },
      });

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          ...DEFAULT_HEADERS,
          authorization: 'auth',
          other: 'yep',
          'x-opaque-id': expect.any(String),
        },
      });
    });

    it('includes the `customHeaders` from the config without filtering them', () => {
      const config = createConfig({
        customHeaders: {
          foo: 'bar',
          hello: 'dolly',
        },
        requestHeadersWhitelist: ['authorization'],
      });
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({});

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          ...DEFAULT_HEADERS,
          foo: 'bar',
          hello: 'dolly',
          'x-opaque-id': expect.any(String),
        },
      });
    });

    it('adds the x-opaque-id header based on the request id', () => {
      const config = createConfig();
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({
        kibanaRequestState: { requestId: 'my-fake-id', requestUuid: 'ignore-this-id' },
      });

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          ...DEFAULT_HEADERS,
          'x-opaque-id': 'my-fake-id',
        },
      });
    });

    it('respect the precedence of auth headers over config headers', () => {
      const config = createConfig({
        customHeaders: {
          foo: 'config',
          hello: 'dolly',
        },
        requestHeadersWhitelist: ['foo'],
      });
      getAuthHeaders.mockReturnValue({
        foo: 'auth',
      });

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({});

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          ...DEFAULT_HEADERS,
          foo: 'auth',
          hello: 'dolly',
          'x-opaque-id': expect.any(String),
        },
      });
    });

    it('respect the precedence of request headers over config headers', () => {
      const config = createConfig({
        customHeaders: {
          foo: 'config',
          hello: 'dolly',
        },
        requestHeadersWhitelist: ['foo'],
      });
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({
        headers: { foo: 'request' },
      });

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          ...DEFAULT_HEADERS,
          foo: 'request',
          hello: 'dolly',
          'x-opaque-id': expect.any(String),
        },
      });
    });

    it('respect the precedence of config headers over default headers', () => {
      const headerKey = Object.keys(DEFAULT_HEADERS)[0];
      const config = createConfig({
        customHeaders: {
          [headerKey]: 'foo',
        },
      });
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest();

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          [headerKey]: 'foo',
          'x-opaque-id': expect.any(String),
        },
      });
    });

    it('respect the precedence of request headers over default headers', () => {
      const headerKey = Object.keys(DEFAULT_HEADERS)[0];
      const config = createConfig({
        requestHeadersWhitelist: [headerKey],
      });
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({
        headers: { [headerKey]: 'foo' },
      });

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          [headerKey]: 'foo',
          'x-opaque-id': expect.any(String),
        },
      });
    });

    it('respect the precedence of x-opaque-id header over config headers', () => {
      const config = createConfig({
        customHeaders: {
          'x-opaque-id': 'from config',
        },
      });
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = httpServerMock.createKibanaRequest({
        headers: { foo: 'request' },
        kibanaRequestState: { requestId: 'from request', requestUuid: 'ignore-this-id' },
      });

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: {
          ...DEFAULT_HEADERS,
          'x-opaque-id': 'from request',
        },
      });
    });

    it('filter headers when called with a `FakeRequest`', () => {
      const config = createConfig({
        requestHeadersWhitelist: ['authorization'],
      });
      getAuthHeaders.mockReturnValue({});

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = {
        headers: {
          authorization: 'auth',
          hello: 'dolly',
        },
      };

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: { ...DEFAULT_HEADERS, authorization: 'auth' },
      });
    });

    it('does not add auth headers when called with a `FakeRequest`', () => {
      const config = createConfig({
        requestHeadersWhitelist: ['authorization', 'foo'],
      });
      getAuthHeaders.mockReturnValue({
        authorization: 'auth',
      });

      const clusterClient = new ClusterClient(config, logger, 'custom-type', getAuthHeaders);
      const request = {
        headers: {
          foo: 'bar',
          hello: 'dolly',
        },
      };

      clusterClient.asScoped(request);

      expect(scopedClient.child).toHaveBeenCalledTimes(1);
      expect(scopedClient.child).toHaveBeenCalledWith({
        headers: { ...DEFAULT_HEADERS, foo: 'bar' },
      });
    });
  });

  describe('#close', () => {
    it('closes both underlying clients', async () => {
      const clusterClient = new ClusterClient(
        createConfig(),
        logger,
        'custom-type',
        getAuthHeaders
      );

      await clusterClient.close();

      expect(internalClient.close).toHaveBeenCalledTimes(1);
      expect(scopedClient.close).toHaveBeenCalledTimes(1);
    });

    it('waits for both clients to close', async (done) => {
      expect.assertions(4);

      const clusterClient = new ClusterClient(
        createConfig(),
        logger,
        'custom-type',
        getAuthHeaders
      );

      let internalClientClosed = false;
      let scopedClientClosed = false;
      let clusterClientClosed = false;

      let closeInternalClient: () => void;
      let closeScopedClient: () => void;

      internalClient.close.mockReturnValue(
        new Promise<void>((resolve) => {
          closeInternalClient = resolve;
        }).then(() => {
          expect(clusterClientClosed).toBe(false);
          internalClientClosed = true;
        })
      );
      scopedClient.close.mockReturnValue(
        new Promise<void>((resolve) => {
          closeScopedClient = resolve;
        }).then(() => {
          expect(clusterClientClosed).toBe(false);
          scopedClientClosed = true;
        })
      );

      clusterClient.close().then(() => {
        clusterClientClosed = true;
        expect(internalClientClosed).toBe(true);
        expect(scopedClientClosed).toBe(true);
        done();
      });

      closeInternalClient!();
      closeScopedClient!();
    });

    it('return a rejected promise is any client rejects', async () => {
      const clusterClient = new ClusterClient(
        createConfig(),
        logger,
        'custom-type',
        getAuthHeaders
      );

      internalClient.close.mockRejectedValue(new Error('error closing client'));

      expect(clusterClient.close()).rejects.toThrowErrorMatchingInlineSnapshot(
        `"error closing client"`
      );
    });

    it('does nothing after the first call', async () => {
      const clusterClient = new ClusterClient(
        createConfig(),
        logger,
        'custom-type',
        getAuthHeaders
      );

      await clusterClient.close();

      expect(internalClient.close).toHaveBeenCalledTimes(1);
      expect(scopedClient.close).toHaveBeenCalledTimes(1);

      await clusterClient.close();
      await clusterClient.close();

      expect(internalClient.close).toHaveBeenCalledTimes(1);
      expect(scopedClient.close).toHaveBeenCalledTimes(1);
    });
  });
});
