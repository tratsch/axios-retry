import http from 'http'
import nock from 'nock'
import axios, { AxiosError, CanceledError, InternalAxiosRequestConfig, isAxiosError } from 'axios'
import axiosRetry, {
  isNetworkError,
  isSafeRequestError,
  isIdempotentRequestError,
  exponentialDelay,
  retryAfter,
  isRetryableError,
  namespace,
  linearDelay
} from '../src/index'

const NETWORK_ERROR = new AxiosError('Some connection error')
NETWORK_ERROR.code = 'ECONNRESET'

function setupResponses(client, responses) {
  const configureResponse = () => {
    const response = responses.shift()
    if (response) {
      response()
    }
  }
  client.interceptors.response.use(
    (result) => {
      configureResponse()
      return result
    },
    (error) => {
      configureResponse()
      return Promise.reject(error)
    }
  )
  configureResponse()
}

describe('axiosRetry(axios, { retries, retryCondition })', () => {
  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  describe('when the response is successful', () => {
    it('should resolve with it', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').reply(200, 'It worked!')
      ])
      axiosRetry(client, { retries: 0 })
      client.get('http://example.com/test').then((result) => {
        expect(result.status).toBe(200)
        done()
      }, done.fail)
    })
  })

  describe('when the response is an error', () => {
    it('should check if it satisfies the `retryCondition`', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').reply(200, 'It worked!')
      ])
      const retryCondition = (error) => {
        expect(error).toEqual(NETWORK_ERROR)
        done()
        return false
      }
      axiosRetry(client, { retries: 1, retryCondition })
      client.get('http://example.com/test').catch(() => {})
    })

    describe('when it satisfies the retry condition', () => {
      it('should resolve with a successful retry', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').reply(200, 'It worked!')
        ])
        axiosRetry(client, { retries: 1, retryCondition: () => true })
        client.get('http://example.com/test').then((result) => {
          expect(result.status).toBe(200)
          expect(result.config[namespace]!.retries).toBe(1)
          expect(result.config[namespace]!.retryCount).toBe(1)
          done()
        }, done.fail)
      })

      it('should not run transformRequest twice', (done) => {
        const client = axios.create({
          transformRequest: [(data) => JSON.stringify(data)]
        })
        setupResponses(client, [
          () =>
            nock('http://example.com')
              .post('/test', (body) => {
                expect(body.a).toBe('b')
                return true
              })
              .replyWithError(NETWORK_ERROR),
          () =>
            nock('http://example.com')
              .post('/test', (body) => {
                expect(body.a).toBe('b')
                return true
              })
              .reply(200, 'It worked!')
        ])
        axiosRetry(client, { retries: 1, retryCondition: () => true })
        client.post('http://example.com/test', { a: 'b' }).then((result) => {
          expect(result.status).toBe(200)
          done()
        }, done.fail)
      })

      it('should reject with a request error if retries <= 0', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR)
        ])
        axiosRetry(client, { retries: 0, retryCondition: () => false })
        client
          .get('http://example.com/test')
          .then(
            () => done.fail(),
            (error) => {
              expect(error).toEqual(NETWORK_ERROR)
              done()
            }
          )
          .catch(done.fail)
      })

      it('should reject with a request error if there are more errors than retries', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(new Error('foo error')),
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR)
        ])
        axiosRetry(client, { retries: 1, retryCondition: () => true })
        client
          .get('http://example.com/test')
          .then(
            () => done.fail(),
            (error) => {
              expect(error).toEqual(NETWORK_ERROR)
              done()
            }
          )
          .catch(done.fail)
      })

      it('should honor the original `timeout` across retries', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').delay(75).replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').delay(75).replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').reply(200)
        ])
        axiosRetry(client, { retries: 3 })
        client
          .get('http://example.com/test', { timeout: 100 })
          .then(
            () => done.fail(),
            (error) => {
              expect(error.code).toBe('ECONNABORTED')
              done()
            }
          )
          .catch(done.fail)
      })

      it('should not make a retry attempt if the whole request lifecycle takes more than `timeout`', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR), // delay >= 200 ms
          () => nock('http://example.com').get('/test').reply(200) // delay >= 400 ms
        ])
        const timeout = 500
        const retries = 2
        axiosRetry(client, {
          retries,
          retryDelay: exponentialDelay,
          shouldResetTimeout: false
        })
        const startDate = new Date()

        client
          .get('http://example.com/test', { timeout })
          .then(
            () => done.fail(),
            (error) => {
              expect(new Date().getTime() - startDate.getTime()).toBeLessThan(timeout)
              expect(error.config[namespace].retryCount).toBe(retries)
              expect(error.code).toBe(NETWORK_ERROR.code)
              done()
            }
          )
          .catch(done.fail)
      })

      it('should reset the original `timeout` between requests', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').delay(75).replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').delay(75).replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').reply(200)
        ])
        axiosRetry(client, { retries: 3, shouldResetTimeout: true })
        client
          .get('http://example.com/test', { timeout: 100 })
          .then((result) => {
            expect(result.status).toBe(200)
            done()
          })
          .catch(done.fail)
      })

      it('should reject with errors without a `config` property without retrying', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').reply(200)
        ])
        // Force returning a plain error without extended information from Axios
        const generatedError = new Error()
        client.interceptors.response.use(null, () => Promise.reject(generatedError))
        axiosRetry(client, { retries: 1, retryCondition: () => true })

        client
          .get('http://example.com/test')
          .then(
            () => done.fail(),
            (error) => {
              expect(error).toEqual(generatedError)
              done()
            }
          )
          .catch(done.fail)
      })

      it('should work with a custom `agent` configuration', (done) => {
        const httpAgent = new http.Agent()
        // Simulate circular structure
        const fakeSocket = { foo: 'foo' }
        // @ts-ignore
        httpAgent.sockets['multisearch.api.softonic.com:80:'] = [fakeSocket]
        // @ts-ignore
        fakeSocket.socket = fakeSocket
        // @ts-ignore
        const client = axios.create({ agent: httpAgent })
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').reply(200, 'It worked!')
        ])
        axiosRetry(client, { retries: 1, retryCondition: () => true })
        client.get('http://example.com/test').then((result) => {
          expect(result.status).toBe(200)
          done()
        }, done.fail)
      })

      it('should work with a custom `httpAgent` configuration', (done) => {
        const httpAgent = new http.Agent()
        // Simulate circular structure
        const fakeSocket = { foo: 'foo' }
        // @ts-ignore
        httpAgent.sockets['multisearch.api.softonic.com:80:'] = [fakeSocket]
        // @ts-ignore
        fakeSocket.socket = fakeSocket
        const client = axios.create({ httpAgent })
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').reply(200, 'It worked!')
        ])
        axiosRetry(client, { retries: 1, retryCondition: () => true })
        client.get('http://example.com/test').then((result) => {
          expect(result.status).toBe(200)
          done()
        }, done.fail)
      })

      describe('when retry condition is returning a promise', () => {
        it('should resolve with a successful retry as usual', (done) => {
          const client = axios.create()
          setupResponses(client, [
            () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
            () => nock('http://example.com').get('/test').reply(200, 'It worked!')
          ])
          axiosRetry(client, {
            retries: 1,
            retryCondition: () =>
              new Promise((res) => {
                res(true)
              })
          })
          client.get('http://example.com/test').then((result) => {
            expect(result.status).toBe(200)
            done()
          }, done.fail)
        })

        it('should reject when promise result is false', (done) => {
          const client = axios.create()
          setupResponses(client, [
            () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
            () => nock('http://example.com').get('/test').reply(200, 'It worked!')
          ])
          axiosRetry(client, {
            retries: 1,
            retryCondition: () =>
              new Promise((res) => {
                res(false)
              })
          })
          client
            .get('http://example.com/test')
            .then(
              () => done.fail(),
              (error) => {
                expect(error).toEqual(NETWORK_ERROR)
                done()
              }
            )
            .catch(done.fail)
        })
      })

      describe('when request is aborted', () => {
        it('should clear timeout if started', (done) => {
          const client = axios.create()
          setupResponses(client, [
            () => nock('http://example.com').get('/test').reply(429),
            () => nock('http://example.com').get('/test').reply(429)
          ])
          axiosRetry(client, {
            retries: 1,
            retryCondition: () => true,
            retryDelay: () => 10000
          })
          const abortController = new AbortController()
          client
            .get('http://example.com/test', { signal: abortController.signal })
            .then(
              () => done.fail(),
              (error) => {
                expect(error).toBeInstanceOf(CanceledError)
                expect(new Date().getTime() - timeStart).toBeLessThan(300)
                done()
              }
            )
            .catch(done.fail)
          setTimeout(() => abortController.abort(), 200)
          const timeStart = new Date().getTime()
        })

        it('should not start a timeout if not started yet', (done) => {
          const client = axios.create()
          setupResponses(client, [
            () => nock('http://example.com').get('/test').reply(429),
            () => nock('http://example.com').get('/test').reply(429)
          ])
          axiosRetry(client, {
            retries: 1,
            retryCondition: () => true,
            retryDelay: () => 10000,
            onRetry: async () => new Promise((resolve) => setTimeout(resolve, 100))
          })
          const abortController = new AbortController()
          client
            .get('http://example.com/test', { signal: abortController.signal })
            .then(
              () => done.fail(),
              (error) => {
                expect(error).toBeInstanceOf(CanceledError)
                expect(new Date().getTime() - timeStart).toBeLessThan(300)
                done()
              }
            )
            .catch(done.fail)
          setTimeout(() => abortController.abort(), 50)
          const timeStart = new Date().getTime()
        })

        it('should cancel old requests', (done) => {
          const client = axios.create()
          setupResponses(client, [
            () => nock('http://example.com').get('/test').delay(100).reply(429),
            () => nock('http://example.com').get('/test').delay(100).reply(429),
            () => nock('http://example.com').get('/test').delay(100).reply(429)
          ])
          axiosRetry(client, {
            retries: 2,
            retryCondition: () => true,
            retryDelay: () => 0
          })
          const abortController = new AbortController()
          client
            .get('http://example.com/test', { signal: abortController.signal })
            .then(
              () => done.fail(),
              (error) => {
                expect(error).toBeInstanceOf(CanceledError)
                expect(new Date().getTime() - timeStart).toBeLessThan(300)
                done()
              }
            )
            .catch(done.fail)
          setTimeout(() => abortController.abort(), 250)
          const timeStart = new Date().getTime()
        })
      })
    })

    describe('when it does NOT satisfy the retry condition', () => {
      it('should reject with the error', (done) => {
        const client = axios.create()
        setupResponses(client, [
          () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
          () => nock('http://example.com').get('/test').reply(200, 'It worked!')
        ])
        axiosRetry(client, { retries: 1, retryCondition: () => false })
        client
          .get('http://example.com/test')
          .then(
            () => done.fail(),
            (error) => {
              expect(error).toEqual(NETWORK_ERROR)
              done()
            }
          )
          .catch(done.fail)
      })

      describe('given as promise', () => {
        it('should reject with the error', (done) => {
          const client = axios.create()
          setupResponses(client, [
            () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
            () => nock('http://example.com').get('/test').reply(200, 'It worked!')
          ])
          axiosRetry(client, {
            retries: 1,
            retryCondition: () => new Promise((_resolve, reject) => reject())
          })
          client
            .get('http://example.com/test')
            .then(
              () => done.fail(),
              (error) => {
                expect(error).toEqual(NETWORK_ERROR)
                done()
              }
            )
            .catch(done.fail)
        })
      })
    })
  })

  it('should use request-specific configuration', (done) => {
    const client = axios.create()
    setupResponses(client, [
      () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
      () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
      () => nock('http://example.com').get('/test').reply(200)
    ])
    axiosRetry(client, { retries: 0 })
    client
      .get('http://example.com/test', {
        'axios-retry': {
          retries: 2
        }
      })
      .then((result) => {
        expect(result.status).toBe(200)
        done()
      }, done.fail)
  })
})

describe('axiosRetry(axios, { validateResponse })', () => {
  afterEach(() => {
    nock.cleanAll()
  })

  describe('when validateResponse is supplied as default option', () => {
    it('should be able to produce an AxiosError with status code of 200', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').reply(200, 'should retry!')
      ])
      axiosRetry(client, {
        retries: 0,
        validateResponse: (response) => response.status !== 200
      })
      client.get('http://example.com/test').catch((err) => {
        expect(isAxiosError(err)).toBeTrue()
        expect(err.response.status).toBe(200)
        done()
      })
    })

    it('should retry based on supplied logic', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').reply(200, 'should retry!'),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').reply(200, 'should retry!'),
        () => nock('http://example.com').get('/test').reply(200, 'ok!')
      ])
      let retryCount = 0
      axiosRetry(client, {
        retries: 4,
        retryCondition: () => true,
        retryDelay: () => {
          retryCount += 1
          return 0
        },
        validateResponse: (response) => {
          if (response.status < 200 || response.status >= 300) return false
          return response.data === 'ok!'
        }
      })
      client.get('http://example.com/test').then((result) => {
        expect(retryCount).toBe(3)
        expect(result.status).toBe(200)
        expect(result.data).toBe('ok!')
        done()
      }, done.fail)
    })
  })

  describe('when validateResponse is supplied as request-specific configuration', () => {
    it('should use request-specific configuration instead', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').reply(200, 'should retry!'),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').reply(200, 'ok!')
      ])
      axiosRetry(client, {
        validateResponse: (response) => response.status >= 200 && response.status < 300
      })
      client
        .get('http://example.com/test', {
          'axios-retry': {
            retryCondition: () => true,
            validateResponse: (response) => {
              if (response.status < 200 || response.status >= 300) return false
              return response.data === 'ok!'
            }
          }
        })
        .then((result) => {
          expect(result.status).toBe(200)
          expect(result.data).toBe('ok!')
          done()
        }, done.fail)
    })

    it('should be able to disable default validateResponse passed', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').reply(200, 'should not retry!'),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').reply(200, 'ok!')
      ])
      axiosRetry(client, {
        validateResponse: (response) => {
          if (response.status < 200 || response.status >= 300) return false
          return response.data === 'ok!'
        }
      })
      client
        .get('http://example.com/test', {
          'axios-retry': {
            retryCondition: () => true,
            validateResponse: null
          }
        })
        .then((result) => {
          expect(result.status).toBe(200)
          expect(result.data).toBe('should not retry!')
          done()
        }, done.fail)
    })
  })
})

describe('axiosRetry(axios, { retries, retryDelay })', () => {
  describe('when custom retryDelay function is supplied', () => {
    it('should execute for each retry', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').reply(200, 'It worked!')
      ])
      let retryCount = 0
      axiosRetry(client, {
        retries: 4,
        retryCondition: () => true,
        retryDelay: () => {
          retryCount += 1
          return 0
        }
      })
      client.get('http://example.com/test').then(() => {
        expect(retryCount).toBe(3)
        done()
      }, done.fail)
    })
  })

  describe('when linearDelay is supplied', () => {
    it('should take more than 600 milliseconds with default delay and 4 retries', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').reply(200, 'It worked!')
      ])
      const timeStart = new Date().getTime()
      axiosRetry(client, {
        retries: 4,
        retryCondition: () => true,
        retryDelay: linearDelay()
      })
      client.get('http://example.com/test').then(() => {
        // 100 + 200 + 300 = 600
        expect(new Date().getTime() - timeStart).toBeGreaterThanOrEqual(600)
        expect(new Date().getTime() - timeStart).toBeLessThan(710)

        done()
      }, done.fail)
    })

    it('should take more than 300 milliseconds with 50ms delay and 4 retries', (done) => {
      const client = axios.create()
      setupResponses(client, [
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
        () => nock('http://example.com').get('/test').reply(200, 'It worked!')
      ])
      const timeStart = new Date().getTime()
      axiosRetry(client, {
        retries: 4,
        retryCondition: () => true,
        retryDelay: linearDelay(50)
      })
      client.get('http://example.com/test').then(() => {
        // 50 + 100 + 150 = 300
        expect(new Date().getTime() - timeStart).toBeGreaterThanOrEqual(300)
        expect(new Date().getTime() - timeStart).toBeLessThan(410)
        done()
      }, done.fail)
    })
  })
})

describe('axiosRetry(axios, { retries, onRetry })', () => {
  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  describe('when the onRetry is handled', () => {
    it('should resolve with correct number of retries', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])
      let retryCalled = 0
      let finalRetryCount = 0
      const onRetry = (retryCount, err, requestConfig) => {
        retryCalled += 1
        finalRetryCount = retryCount

        expect(err).not.toBe(undefined)
        expect(requestConfig).not.toBe(undefined)
      }
      axiosRetry(client, { retries: 2, onRetry })
      client.get('http://example.com/test').catch(() => {
        expect(retryCalled).toBe(2)
        expect(finalRetryCount).toBe(2)
        done()
      })
    })

    it('should use onRetry set on request', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])
      let retryCalled = 0
      let finalRetryCount = 0
      const onRetry = (retryCount, err, requestConfig) => {
        retryCalled += 1
        finalRetryCount = retryCount

        expect(err).not.toBe(undefined)
        expect(requestConfig).not.toBe(undefined)
      }
      axiosRetry(client, { retries: 2 })
      client
        .get('http://example.com/test', {
          'axios-retry': {
            onRetry
          }
        })
        .catch(() => {
          expect(retryCalled).toBe(2)
          expect(finalRetryCount).toBe(2)
          done()
        })
    })
  })

  describe('when the onRetry is returning a promise', () => {
    it('should resolve with correct number of retries', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])

      let retryCalled = 0
      let finalRetryCount = 0
      const onRetry = (retryCount, err, requestConfig) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            retryCalled += 1
            finalRetryCount = retryCount

            expect(err).not.toBe(undefined)
            expect(requestConfig).not.toBe(undefined)
            resolve(void 0)
          }, 100)
        })

      axiosRetry(client, { retries: 2, onRetry })
      client.get('http://example.com/test').catch(() => {
        expect(retryCalled).toBe(2)
        expect(finalRetryCount).toBe(2)
        done()
      })
    })

    it('should reject with the error', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])

      let retryCalled = 0
      let finalRetryCount = 0
      const onRetry = (retryCount, err, requestConfig) =>
        new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            retryCalled += 1
            finalRetryCount = retryCount

            expect(err).not.toBe(undefined)
            expect(requestConfig).not.toBe(undefined)
            reject(new Error('onRetry error'))
          }, 100)
        })

      axiosRetry(client, { retries: 2, onRetry })

      client
        .get('http://example.com/test')
        .then(
          () => done.fail(),
          (error) => {
            expect(error.message).toBe('onRetry error')
            expect(retryCalled).toBe(1)
            expect(finalRetryCount).toBe(1)
            done()
          }
        )
        .catch(done.fail)
    })

    it('should use onRetry set on request', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])

      let retryCalled = 0
      let finalRetryCount = 0
      const onRetry = (retryCount, err, requestConfig) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            retryCalled += 1
            finalRetryCount = retryCount

            expect(err).not.toBe(undefined)
            expect(requestConfig).not.toBe(undefined)
            resolve(void 0)
          }, 100)
        })
      axiosRetry(client, { retries: 2 })
      client
        .get('http://example.com/test', {
          'axios-retry': {
            onRetry
          }
        })
        .catch(() => {
          expect(retryCalled).toBe(2)
          expect(finalRetryCount).toBe(2)
          done()
        })
    })
  })
})

describe('axiosRetry(axios, { onMaxRetryTimesExceeded })', () => {
  const customError = new Error('CustomErrorAfterMaxRetryTimesExceeded')

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  describe('when the onMaxRetryTimesExceeded is handled', () => {
    it('should use onMaxRetryTimesExceeded set on request', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])
      let calledCount = 0
      let finalRetryCount = 0
      const onMaxRetryTimesExceeded = (err, retryCount) => {
        calledCount += 1
        finalRetryCount = retryCount

        expect(err).not.toBe(undefined)
      }
      axiosRetry(client, { retries: 2, onMaxRetryTimesExceeded })
      client
        .get('http://example.com/test')
        .then(
          () => done.fail(),
          (error) => {
            expect(calledCount).toBe(1)
            expect(finalRetryCount).toBe(2)
            done()
          }
        )
        .catch(done.fail)
    })

    it('should reject with the custom error', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])
      const onMaxRetryTimesExceeded = () => {
        throw customError
      }
      axiosRetry(client, {
        retries: 2,
        onMaxRetryTimesExceeded
      })
      client
        .get('http://example.com/test')
        .then(
          () => done.fail(),
          (error) => {
            expect(error).toEqual(customError)
            done()
          }
        )
        .catch(done.fail)
    })
  })

  describe('when the onMaxRetryTimesExceeded is returning a promise', () => {
    it('should use onMaxRetryTimesExceeded set on request', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])
      let calledCount = 0
      let finalRetryCount = 0
      const onMaxRetryTimesExceeded = (err, retryCount) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            calledCount += 1
            finalRetryCount = retryCount

            expect(err).not.toBe(undefined)
            resolve(void 0)
          }, 100)
        })
      axiosRetry(client, { retries: 2, onMaxRetryTimesExceeded })
      client
        .get('http://example.com/test')
        .then(
          () => done.fail(),
          (error) => {
            expect(calledCount).toBe(1)
            expect(finalRetryCount).toBe(2)
            done()
          }
        )
        .catch(done.fail)
    })

    it('should reject with the custom error', (done) => {
      const client = axios.create()
      setupResponses(client, [() => nock('http://example.com').get('/test').reply(500, 'Failed!')])
      const onMaxRetryTimesExceeded = (err, retryCount) =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            expect(err).not.toBe(undefined)
            reject(customError)
          }, 100)
        })
      axiosRetry(client, {
        retries: 2,
        onMaxRetryTimesExceeded
      })
      client
        .get('http://example.com/test')
        .then(
          () => done.fail(),
          (error) => {
            expect(error).toEqual(customError)
            done()
          }
        )
        .catch(done.fail)
    })
  })
})

describe('isNetworkError(error)', () => {
  it('should be true for network errors like connection refused', () => {
    const connectionRefusedError = new AxiosError()
    connectionRefusedError.code = 'ECONNREFUSED'

    expect(isNetworkError(connectionRefusedError)).toBe(true)
  })

  it('should be false for timeout errors', () => {
    const timeoutError = new AxiosError()
    timeoutError.code = 'ECONNABORTED'

    expect(isNetworkError(timeoutError)).toBe(false)
  })

  it('should be false for errors with a response', () => {
    const responseError = new AxiosError('Response error')
    responseError.response = { status: 500 } as AxiosError['response']

    expect(isNetworkError(responseError)).toBe(false)
  })

  it('should be false for other errors', () => {
    expect(isNetworkError(new Error())).toBe(false)
  })
})

describe('isSafeRequestError(error)', () => {
  ;['get', 'head', 'options'].forEach((method) => {
    it(`should be true for "${method}" requests with a 5xx response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']
      errorResponse.response = { status: 500 } as AxiosError['response']

      expect(isSafeRequestError(errorResponse)).toBe(true)
    })

    it(`should be true for "${method}" requests without a response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']

      expect(isSafeRequestError(errorResponse)).toBe(true)
    })
  })

  const methods = ['post', 'put', 'patch', 'delete']
  methods.forEach((method) => {
    it(`should be false for "${method}" requests with a 5xx response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']
      errorResponse.response = { status: 500 } as AxiosError['response']

      expect(isSafeRequestError(errorResponse)).toBe(false)
    })

    it(`should be false for "${method}" requests without a response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']

      expect(isSafeRequestError(errorResponse)).toBe(false)
    })
  })

  it('should be false for errors without a `config`', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.response = { status: 500 } as AxiosError['response']

    expect(isSafeRequestError(errorResponse)).toBe(false)
  })

  it('should be false for non-5xx responses', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.config = { method: 'get' } as AxiosError['config']
    errorResponse.response = { status: 404 } as AxiosError['response']

    expect(isSafeRequestError(errorResponse)).toBe(false)
  })

  it('should be false for aborted requests', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.code = 'ECONNABORTED'
    errorResponse.config = { method: 'get' } as AxiosError['config']

    expect(isSafeRequestError(errorResponse)).toBe(false)
  })
})

describe('isIdempotentRequestError(error)', () => {
  ;['get', 'head', 'options', 'put', 'delete'].forEach((method) => {
    it(`should be true for "${method}" requests with a 5xx response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']
      errorResponse.response = { status: 500 } as AxiosError['response']

      expect(isIdempotentRequestError(errorResponse)).toBe(true)
    })

    it(`should be true for "${method}" requests without a response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']

      expect(isIdempotentRequestError(errorResponse)).toBe(true)
    })
  })

  const methods = ['post', 'patch']
  methods.forEach((method) => {
    it(`should be false for "${method}" requests with a 5xx response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']
      errorResponse.response = { status: 500 } as AxiosError['response']

      expect(isIdempotentRequestError(errorResponse)).toBe(false)
    })

    it(`should be false for "${method}" requests without a response`, () => {
      const errorResponse = new AxiosError('Error response')
      errorResponse.config = { method } as AxiosError['config']
      errorResponse.response = { status: 500 } as AxiosError['response']

      expect(isIdempotentRequestError(errorResponse)).toBe(false)
    })
  })

  // eslint-disable-next-line jasmine/no-spec-dupes
  it('should be false for errors without a `config`', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.response = { status: 500 } as AxiosError['response']

    expect(isIdempotentRequestError(errorResponse)).toBe(false)
  })

  // eslint-disable-next-line jasmine/no-spec-dupes
  it('should be false for non-5xx responses', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.config = { method: 'get' } as AxiosError['config']
    errorResponse.response = { status: 404 } as AxiosError['response']

    expect(isIdempotentRequestError(errorResponse)).toBe(false)
  })

  // eslint-disable-next-line jasmine/no-spec-dupes
  it('should be false for aborted requests', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.code = 'ECONNABORTED'
    errorResponse.config = { method: 'get' } as AxiosError['config']

    expect(isIdempotentRequestError(errorResponse)).toBe(false)
  })
})

describe('exponentialDelay', () => {
  it('should return exponential retry delay', () => {
    function assertTime(retryCount) {
      const min = Math.pow(2, retryCount) * 100
      const max = Math.pow(2, retryCount * 100) * 0.2
      const time = exponentialDelay(retryCount)

      expect(time >= min && time <= max).toBe(true)
    }

    ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(assertTime)
  })

  it('should change delay time when specifying delay factor', () => {
    function assertTime(retryCount) {
      const min = Math.pow(2, retryCount) * 1000
      const max = Math.pow(2, retryCount * 1000) * 0.2
      const time = exponentialDelay(retryCount, undefined, 1000)

      expect(time >= min && time <= max).toBe(true)
    }

    ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(assertTime)
  })
})

describe('linearDelay', () => {
  it('should return liner retry delay', () => {
    const linearDelayFunc = linearDelay()

    function assertTime(retryCount) {
      const time = linearDelayFunc(retryCount, undefined)

      expect(time).toBe(100 * retryCount)
    }

    ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(assertTime)
  })

  it('should change delay time when specifying delay factor', () => {
    const delayFactor = 300
    const linearDelayFunc = linearDelay(delayFactor)

    function assertTime(retryCount) {
      const time = linearDelayFunc(retryCount, undefined)

      expect(time).toBe(delayFactor * retryCount)
    }

    ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(assertTime)
  })
})

describe('retryAfter', () => {
  it('should understand a numeric Retry-After header', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.response = { status: 429 } as AxiosError['response']
    // @ts-ignore
    errorResponse.response.headers = { 'retry-after': '10' }
    const time = retryAfter(errorResponse)

    expect(time).toBe(10000)
  })

  it('should ignore a negative numeric Retry-After header', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.response = { status: 429 } as AxiosError['response']
    // @ts-ignore
    errorResponse.response.headers = { 'retry-after': '-10' }
    const time = retryAfter(errorResponse)

    expect(time).toBe(0)
  })

  it('should understand a date Retry-After header', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.response = { status: 429 } as AxiosError['response']
    const date = new Date()
    date.setSeconds(date.getSeconds() + 10)
    // @ts-ignore
    errorResponse.response.headers = { 'retry-after': date.toUTCString() }
    const time = retryAfter(errorResponse)

    expect(time >= 9000 && time <= 10000).toBe(true)
  })

  it('should ignore a past Retry-After header', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.response = { status: 429 } as AxiosError['response']
    const date = new Date()
    date.setSeconds(date.getSeconds() - 10)
    // @ts-ignore
    errorResponse.response.headers = { 'retry-after': date.toUTCString() }
    const time = retryAfter(errorResponse)

    expect(time).toBe(0)
  })

  it('should ignore an invalid Retry-After header', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.response = { status: 429 } as AxiosError['response']
    // @ts-ignore
    errorResponse.response.headers = { 'retry-after': 'a couple minutes' }
    const time = retryAfter(errorResponse)

    expect(time).toBe(0)
  })
})

describe('isRetryableError(error)', () => {
  it('should be false for aborted requests', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.code = 'ECONNABORTED'

    expect(isRetryableError(errorResponse)).toBe(false)
  })

  it('should be true for timeouts', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.code = 'ECONNRESET'

    expect(isRetryableError(errorResponse)).toBe(true)
  })

  it('should be true for a 5xx response', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.code = 'ECONNRESET'
    errorResponse.response = { status: 500 } as AxiosError['response']

    expect(isRetryableError(errorResponse)).toBe(true)
  })

  it('should be false for a response !== 5xx', () => {
    const errorResponse = new AxiosError('Error response')
    errorResponse.code = 'ECONNRESET'
    errorResponse.response = { status: 400 } as AxiosError['response']

    expect(isRetryableError(errorResponse)).toBe(false)
  })
})

describe('axiosRetry interceptors', () => {
  it('should be able to successfully eject interceptors added by axiosRetry', () => {
    const client = axios.create()
    // @ts-ignore
    expect(client.interceptors.request.handlers.length).toBe(0)
    // @ts-ignore
    expect(client.interceptors.response.handlers.length).toBe(0)
    const { requestInterceptorId, responseInterceptorId } = axiosRetry(client)
    // @ts-ignore
    expect(client.interceptors.request.handlers.length).toBe(1)
    // @ts-ignore
    expect(client.interceptors.response.handlers.length).toBe(1)
    // @ts-ignore
    expect(client.interceptors.request.handlers[0]).not.toBe(null)
    // @ts-ignore
    expect(client.interceptors.response.handlers[0]).not.toBe(null)
    client.interceptors.request.eject(requestInterceptorId)
    client.interceptors.response.eject(responseInterceptorId)
    // @ts-ignore
    expect(client.interceptors.request.handlers[0]).toBe(null)
    // @ts-ignore
    expect(client.interceptors.response.handlers[0]).toBe(null)
  })
})

describe('when requests are made', () => {
  it('should be that lastRequestTime is accurate', (done) => {
    const client = axios.create()
    setupResponses(client, [
      () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
      () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
      () => nock('http://example.com').get('/test').replyWithError(NETWORK_ERROR),
      () => nock('http://example.com').get('/test').reply(200, 'It worked!')
    ])

    function getLastRequestTime(config?: InternalAxiosRequestConfig<any>) {
      const lastRequestTime = config?.['axios-retry']?.lastRequestTime

      expect(lastRequestTime).toBeInstanceOf(Number)
      return lastRequestTime as number
    }

    const lastRequestTimes: number[] = []
    const DELAY = 500
    axiosRetry(client, {
      retries: 3,
      retryDelay: () => DELAY,
      shouldResetTimeout: true,
      onRetry(_retryCount, error, _requestConfig) {
        const lastRequestTime = getLastRequestTime(error.config)
        lastRequestTimes.push(lastRequestTime)
      }
    })

    const startTime = Date.now()
    client
      .get('http://example.com/test')
      .then((response) => {
        const lastRequestTime = getLastRequestTime(response.config)
        lastRequestTimes.push(lastRequestTime)

        expect(lastRequestTimes.length).toBe(4)

        const [a, b, c, d] = lastRequestTimes

        expect(a - startTime).toBeGreaterThanOrEqual(0)
        expect(b - a).toBeGreaterThanOrEqual(DELAY)
        expect(c - b).toBeGreaterThanOrEqual(DELAY)
        expect(d - c).toBeGreaterThanOrEqual(DELAY)

        // check to ensure that the delays are not unreasonably long
        expect(b - a).toBeLessThan(DELAY * 1.5)
        expect(c - b).toBeLessThan(DELAY * 1.5)
        expect(d - c).toBeLessThan(DELAY * 1.5)

        done()
      })
      .catch(done.fail)
  })
})
