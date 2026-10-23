// Sulfur's window on Linux: GTK 3 around WebKitGTK, the system's own title bar

#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include "window_linux.h"
#include "_cgo_export.h"

static GtkWidget *win;
static WebKitWebView *view;
static WebKitUserContentManager *ucm;
static int maxed;

static void on_message(WebKitUserContentManager *m, WebKitJavascriptResult *r, gpointer d) {
	JSCValue *v = webkit_javascript_result_get_js_value(r);
	char *s = jsc_value_to_string(v);
	sxMessage(s);
	g_free(s);
}

// a close asked for with the window's own control goes to the page, which asks about unsaved files
static gboolean on_delete(GtkWidget *w, GdkEvent *e, gpointer d) {
	sxCloseRequest();
	return TRUE;
}

static gboolean on_state(GtkWidget *w, GdkEventWindowState *e, gpointer d) {
	maxed = (e->new_window_state & GDK_WINDOW_STATE_MAXIMIZED) != 0;
	return FALSE;
}

static gboolean on_idle(gpointer p) {
	sxIdle((uintptr_t)p);
	return G_SOURCE_REMOVE;
}

void sx_new(const char *title, int w, int h, int minw, int minh, const char *datadir, const char *cachedir) {
	gtk_init(NULL, NULL);
	g_set_prgname("sulfur");
	WebKitWebsiteDataManager *mgr = webkit_website_data_manager_new("base-data-directory", datadir, "base-cache-directory", cachedir, NULL);
	WebKitWebContext *ctx = webkit_web_context_new_with_website_data_manager(mgr);
	ucm = webkit_user_content_manager_new();
	webkit_user_content_manager_register_script_message_handler(ucm, "sx");
	g_signal_connect(ucm, "script-message-received::sx", G_CALLBACK(on_message), NULL);
	view = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "web-context", ctx, "user-content-manager", ucm, NULL));
	GdkRGBA bg = {0.12, 0.12, 0.12, 1.0};
	webkit_web_view_set_background_color(view, &bg);

	win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
	gtk_window_set_title(GTK_WINDOW(win), title);
	gtk_window_set_default_size(GTK_WINDOW(win), w, h);
	gtk_widget_set_size_request(win, minw, minh);
	gtk_window_set_position(GTK_WINDOW(win), GTK_WIN_POS_CENTER);
	gtk_window_set_icon_name(GTK_WINDOW(win), "sulfur");
	// the window's own dark under the page, so its start isn't a flash of white
	GtkCssProvider *css = gtk_css_provider_new();
	gtk_css_provider_load_from_data(css, "window { background-color: #1f1f1f; }", -1, NULL);
	gtk_style_context_add_provider_for_screen(gdk_screen_get_default(), GTK_STYLE_PROVIDER(css), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
	g_object_unref(css);
	gtk_container_add(GTK_CONTAINER(win), GTK_WIDGET(view));
	g_signal_connect(win, "delete-event", G_CALLBACK(on_delete), NULL);
	g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
	g_signal_connect(win, "window-state-event", G_CALLBACK(on_state), NULL);
	gtk_widget_show_all(win);
}

void sx_init_script(const char *js) {
	WebKitUserScript *s = webkit_user_script_new(js, WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, NULL, NULL);
	webkit_user_content_manager_add_script(ucm, s);
	webkit_user_script_unref(s);
}

void sx_navigate(const char *url) { webkit_web_view_load_uri(view, url); }
void sx_eval(const char *js) { webkit_web_view_run_javascript(view, js, NULL, NULL, NULL); }
void sx_run(void) { gtk_main(); }
void sx_post(uintptr_t id) { g_idle_add(on_idle, (gpointer)id); }
void sx_title(const char *t) { gtk_window_set_title(GTK_WINDOW(win), t); }
void sx_minimize(void) { gtk_window_iconify(GTK_WINDOW(win)); }
void sx_toggle_max(void) {
	if (maxed) gtk_window_unmaximize(GTK_WINDOW(win)); else gtk_window_maximize(GTK_WINDOW(win));
}
int sx_maxed(void) { return maxed; }
void sx_destroy(void) { gtk_widget_destroy(win); }
