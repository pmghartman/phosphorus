#ifndef SULFUR_WINDOW_H
#define SULFUR_WINDOW_H

#include <stdint.h>

void sx_new(const char *title, int w, int h, int minw, int minh, const char *datadir, const char *cachedir);
void sx_init_script(const char *js);
void sx_navigate(const char *url);
void sx_eval(const char *js);
void sx_run(void);
void sx_post(uintptr_t id);
void sx_title(const char *title);
void sx_minimize(void);
void sx_toggle_max(void);
int sx_maxed(void);
void sx_destroy(void);

#endif
