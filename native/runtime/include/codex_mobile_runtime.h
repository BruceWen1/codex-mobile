/* -*- coding: utf-8 -*-
 * codex_mobile_runtime.h
 * Embedded Codex C Interface
 * =====================
 * Exposes the original app-server to mobile native hosts using owned UTF-8 buffers.
 */
#ifndef CODEX_MOBILE_RUNTIME_H
#define CODEX_MOBILE_RUNTIME_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize the embedded original Codex engine.
 *
 * Args:
 *     home (const char *): Private native state directory.
 *     workspace (const char *): Initial working directory.
 *     executor (const char *): Packaged helper path, or NULL for file operations.
 * Returns:
 *     char *: Owned UTF-8 JSON result released with codex_mobile_free.
 */
char *codex_mobile_start(const char *home, const char *workspace, const char *executor);
/**
 * Dispatch an original JSON-RPC message.
 *
 * Args:
 *     input (const char *): Original null-terminated protocol message.
 * Returns:
 *     char *: Owned UTF-8 JSON response released with codex_mobile_free.
 */
char *codex_mobile_request(const char *input);
/**
 * Drain actual original engine events in order.
 *
 * Args:
 *     None.
 * Returns:
 *     char *: Owned UTF-8 JSON event array released with codex_mobile_free.
 */
char *codex_mobile_poll(void);
/**
 * Release an owned runtime response buffer.
 *
 * Args:
 *     buffer (char *): Buffer returned by the runtime, released exactly once.
 * Returns:
 *     void: The response buffer is released.
 */
void codex_mobile_free(char *buffer);

#ifdef __cplusplus
}
#endif
#endif
