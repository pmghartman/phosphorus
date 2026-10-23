// Sulfur's window on macOS: WKWebView in an NSWindow whose title bar is the page's own,
// the system's traffic lights over it

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include "window_darwin.h"
#include "_cgo_export.h"

static NSWindow *win;
static WKWebView *view;
static WKUserContentController *ucc;
static BOOL forced;
static int maxed;

@interface SXDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler>
@end

@implementation SXDelegate
- (void)userContentController:(WKUserContentController *)c didReceiveScriptMessage:(WKScriptMessage *)m {
	if ([m.body isKindOfClass:[NSString class]]) sxMessage((char *)[(NSString *)m.body UTF8String]);
}
// the red button and Cmd+Q ask the page, which asks about unsaved files
- (BOOL)windowShouldClose:(NSWindow *)w {
	if (forced) return YES;
	sxCloseRequest();
	return NO;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)a {
	if (forced) return NSTerminateNow;
	sxCloseRequest();
	return NSTerminateCancel;
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)a { return YES; }
- (void)windowDidResize:(NSNotification *)n { maxed = win.isZoomed; [self lights]; }
- (void)windowDidEnterFullScreen:(NSNotification *)n { [self lights]; }
- (void)windowDidExitFullScreen:(NSNotification *)n { [self lights]; }
// the traffic lights set into the taller title bar the page draws
- (void)lights {
	NSButton *c = [win standardWindowButton:NSWindowCloseButton];
	NSView *bar = c.superview.superview;
	if (!bar) return;
	CGFloat h = 35;
	NSRect f = bar.frame;
	f.size.height = h;
	f.origin.y = win.frame.size.height - h;
	bar.frame = f;
	CGFloat x = 13;
	for (NSNumber *k in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)]) {
		NSButton *b = [win standardWindowButton:(NSWindowButtonType)k.integerValue];
		NSRect r = b.frame;
		r.origin.x = x;
		r.origin.y = (h - r.size.height) / 2;
		b.frame = r;
		x += r.size.width + 8;
	}
}
@end

static SXDelegate *delegate;

static NSMenuItem *item(NSMenu *m, NSString *title, SEL sel, NSString *key) {
	return [m addItemWithTitle:title action:sel keyEquivalent:key];
}

// the menu bar the keys come from: Cmd+C, Cmd+V and the rest reach the page through it
static void menus(void) {
	NSMenu *bar = [NSMenu new];
	NSMenuItem *appItem = [NSMenuItem new];
	[bar addItem:appItem];
	NSMenu *app = [NSMenu new];
	item(app, @"Hide Sulfur", @selector(hide:), @"h");
	[app addItem:[NSMenuItem separatorItem]];
	item(app, @"Quit Sulfur", @selector(terminate:), @"q");
	appItem.submenu = app;
	NSMenuItem *editItem = [NSMenuItem new];
	[bar addItem:editItem];
	NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
	item(edit, @"Undo", @selector(undo:), @"z");
	item(edit, @"Redo", @selector(redo:), @"Z");
	[edit addItem:[NSMenuItem separatorItem]];
	item(edit, @"Cut", @selector(cut:), @"x");
	item(edit, @"Copy", @selector(copy:), @"c");
	item(edit, @"Paste", @selector(paste:), @"v");
	item(edit, @"Select All", @selector(selectAll:), @"a");
	editItem.submenu = edit;
	NSMenuItem *winItem = [NSMenuItem new];
	[bar addItem:winItem];
	NSMenu *wm = [[NSMenu alloc] initWithTitle:@"Window"];
	item(wm, @"Minimize", @selector(performMiniaturize:), @"m");
	item(wm, @"Zoom", @selector(performZoom:), @"");
	winItem.submenu = wm;
	[NSApp setMainMenu:bar];
	[NSApp setWindowsMenu:wm];
}

void sx_new(const char *title, int w, int h, int minw, int minh) {
	[NSApplication sharedApplication];
	[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
	delegate = [SXDelegate new];
	[NSApp setDelegate:delegate];
	menus();

	WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
	ucc = cfg.userContentController;
	[ucc addScriptMessageHandler:delegate name:@"sx"];
	NSRect frame = NSMakeRect(0, 0, w, h);
	view = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
	[view setValue:@NO forKey:@"drawsBackground"];
	view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

	win = [[NSWindow alloc] initWithContentRect:frame
		styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView)
		backing:NSBackingStoreBuffered defer:NO];
	win.title = [NSString stringWithUTF8String:title];
	win.titlebarAppearsTransparent = YES;
	win.titleVisibility = NSWindowTitleHidden;
	win.backgroundColor = [NSColor colorWithRed:0.12 green:0.12 blue:0.12 alpha:1];
	win.minSize = NSMakeSize(minw, minh);
	win.delegate = delegate;
	win.releasedWhenClosed = NO;
	win.contentView = view;
	[win center];
	[win makeKeyAndOrderFront:nil];
	[delegate lights];
	[NSApp activateIgnoringOtherApps:YES];
}

void sx_init_script(const char *js) {
	WKUserScript *s = [[WKUserScript alloc] initWithSource:[NSString stringWithUTF8String:js]
		injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
	[ucc addUserScript:s];
}

void sx_navigate(const char *url) {
	[view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:[NSString stringWithUTF8String:url]]]];
}
void sx_eval(const char *js) { [view evaluateJavaScript:[NSString stringWithUTF8String:js] completionHandler:nil]; }
void sx_run(void) { [NSApp run]; }
void sx_post(uintptr_t id) { dispatch_async(dispatch_get_main_queue(), ^{ sxIdle(id); }); }
void sx_title(const char *t) { win.title = [NSString stringWithUTF8String:t]; }
void sx_minimize(void) { [win miniaturize:nil]; }
void sx_toggle_max(void) { [win zoom:nil]; }
int sx_maxed(void) { return maxed; }
void sx_destroy(void) { forced = YES; [NSApp terminate:nil]; }
void sx_drag(void) {
	NSEvent *e = NSApp.currentEvent;
	if (e) [win performWindowDragWithEvent:e];
}
