/* What libdispatch gives the core on macOS, for a browser that has no libdispatch.
 *
 * Without -pthread (the default build) every pass simply runs in order: one thread, no shared memory,
 * works on any host and needs no special headers. With -pthread the same passes are handed to a pool of
 * workers that stays alive between them, which needs a cross-origin isolated page and a Worker to run in,
 * because the browser's main thread must not block. Either way the pixels come out identical — the passes
 * are independent by construction. */
#ifndef DARKROOM_DISPATCH_SHIM_H
#define DARKROOM_DISPATCH_SHIM_H
#include <stddef.h>

#define DISPATCH_APPLY_AUTO ((void *)0)
typedef void *dispatch_queue_t;

#ifndef __EMSCRIPTEN_PTHREADS__

static void dispatch_apply_f(size_t count, dispatch_queue_t queue, void *context, void (*work)(void *, size_t)) {
    (void)queue;
    for (size_t i = 0; i < count; ++i) work(context, i);
}

#else

#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>

#define DARKROOM_POOL_MAX 16

typedef struct {
    pthread_mutex_t lock;
    pthread_cond_t wake, done;
    size_t size;               /* worker threads, not counting the caller */
    unsigned long generation;  /* bumped once per pass, so a worker knows the pass is a new one */
    size_t running;
    void *context;
    void (*work)(void *, size_t);
    size_t count;
    atomic_size_t next;
} darkroom_pool;

static darkroom_pool darkroom_shared = { PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER,
                                         PTHREAD_COND_INITIALIZER, 0, 0, 0, NULL, NULL, 0, 0 };

static void darkroom_drain(darkroom_pool *pool) {
    for (;;) {
        size_t i = atomic_fetch_add(&pool->next, 1);
        if (i >= pool->count) return;
        pool->work(pool->context, i);
    }
}

static void *darkroom_worker(void *raw) {
    darkroom_pool *pool = raw;
    unsigned long seen = 0;
    for (;;) {
        pthread_mutex_lock(&pool->lock);
        while (pool->generation == seen) pthread_cond_wait(&pool->wake, &pool->lock);
        seen = pool->generation;
        pthread_mutex_unlock(&pool->lock);

        darkroom_drain(pool);

        pthread_mutex_lock(&pool->lock);
        if (--pool->running == 0) pthread_cond_signal(&pool->done);
        pthread_mutex_unlock(&pool->lock);
    }
    return NULL;
}

static void dispatch_apply_f(size_t count, dispatch_queue_t queue, void *context, void (*work)(void *, size_t)) {
    (void)queue;
    if (!count) return;
    darkroom_pool *pool = &darkroom_shared;
    pthread_mutex_lock(&pool->lock);
    static int started = 0;
    if (!started) {
        started = 1;
        long cores = sysconf(_SC_NPROCESSORS_ONLN);
        size_t want = cores > 1 ? (size_t)cores - 1 : 0;
        if (want > DARKROOM_POOL_MAX) want = DARKROOM_POOL_MAX;
        for (size_t i = 0; i < want; ++i) {
            pthread_t thread;
            if (pthread_create(&thread, NULL, darkroom_worker, pool) != 0) break;
            pool->size = i + 1;
        }
    }
    /* Every worker wakes on every pass, so the count it decrements is exact; the ones that find the rows
       already taken come straight back. */
    size_t helpers = pool->size;
    pool->context = context;
    pool->work = work;
    pool->count = count;
    atomic_store(&pool->next, 0);
    pool->running = helpers;
    pool->generation++;
    if (helpers) pthread_cond_broadcast(&pool->wake);
    pthread_mutex_unlock(&pool->lock);

    darkroom_drain(pool);   /* the caller is a worker too */

    if (helpers) {
        pthread_mutex_lock(&pool->lock);
        while (pool->running) pthread_cond_wait(&pool->done, &pool->lock);
        pthread_mutex_unlock(&pool->lock);
    }
}

#endif
#endif
