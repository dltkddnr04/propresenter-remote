//go:build darwin

#import <Cocoa/Cocoa.h>
#import <CoreImage/CoreImage.h>
#import <dispatch/dispatch.h>

extern void goMenuOpen(void);
extern void goMenuConfigure(void);
extern void goMenuQuit(void);

@interface ProPresenterMenuDelegate : NSObject
- (void)togglePopover:(id)sender;
- (void)openBrowser:(id)sender;
- (void)configure:(id)sender;
- (void)quit:(id)sender;
@end

static ProPresenterMenuDelegate *menuDelegate;
static NSStatusItem *statusItem;
static NSPopover *statusPopover;

static NSImage *qrImageForURL(NSString *value, CGFloat displaySize) {
    CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
    [filter setValue:[value dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
    [filter setValue:@"H" forKey:@"inputCorrectionLevel"];
    CIImage *source = filter.outputImage;
    if (source == nil) return nil;

    CGRect extent = source.extent;
    CGFloat scale = floor(displaySize / MAX(extent.size.width, extent.size.height));
    CIImage *scaled = [source imageByApplyingTransform:CGAffineTransformMakeScale(MAX(scale, 1), MAX(scale, 1))];
    NSCIImageRep *representation = [NSCIImageRep imageRepWithCIImage:scaled];
    NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(displaySize, displaySize)];
    [image addRepresentation:representation];
    return image;
}

static NSTextField *label(NSString *value, NSRect frame, CGFloat size) {
    NSTextField *field = [[NSTextField alloc] initWithFrame:frame];
    field.stringValue = value;
    field.editable = NO;
    field.selectable = NO;
    field.bezeled = NO;
    field.drawsBackground = NO;
    field.font = [NSFont systemFontOfSize:size];
    field.alignment = NSTextAlignmentCenter;
    return field;
}

static NSButton *button(NSString *title, NSRect frame, SEL action) {
    NSButton *control = [[NSButton alloc] initWithFrame:frame];
    control.title = title;
    control.bezelStyle = NSBezelStyleRounded;
    control.target = menuDelegate;
    control.action = action;
    return control;
}

static NSViewController *popoverController(NSString *accessURL) {
    const CGFloat width = 336;
    const CGFloat height = 414;
    NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];

    NSTextField *title = label(@"ProPresenter Remote", NSMakeRect(18, 378, width - 36, 24), 18);
    title.font = [NSFont boldSystemFontOfSize:18];
    [view addSubview:title];
    [view addSubview:label(@"휴대폰으로 QR 코드를 스캔하세요", NSMakeRect(18, 354, width - 36, 18), 12)];

    NSImageView *imageView = [[NSImageView alloc] initWithFrame:NSMakeRect(58, 124, 220, 220)];
    imageView.image = qrImageForURL(accessURL, 220);
    imageView.imageScaling = NSImageScaleAxesIndependently;
    [view addSubview:imageView];

    NSTextField *urlField = [[NSTextField alloc] initWithFrame:NSMakeRect(18, 94, width - 36, 22)];
    urlField.stringValue = accessURL;
    urlField.editable = NO;
    urlField.selectable = YES;
    urlField.bezeled = NO;
    urlField.drawsBackground = NO;
    urlField.alignment = NSTextAlignmentCenter;
    urlField.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    urlField.lineBreakMode = NSLineBreakByTruncatingMiddle;
    [view addSubview:urlField];

    [view addSubview:button(@"브라우저 열기", NSMakeRect(18, 48, 144, 32), @selector(openBrowser:))];
    [view addSubview:button(@"Worker URL 설정", NSMakeRect(174, 48, 144, 32), @selector(configure:))];
    [view addSubview:button(@"종료", NSMakeRect(118, 10, 100, 28), @selector(quit:))];

    NSViewController *controller = [[NSViewController alloc] init];
    controller.view = view;
    return controller;
}

@implementation ProPresenterMenuDelegate
- (void)togglePopover:(id)sender {
    if (statusPopover.shown) {
        [statusPopover performClose:sender];
        return;
    }
    [statusPopover showRelativeToRect:statusItem.button.bounds ofView:statusItem.button preferredEdge:NSRectEdgeMinY];
}
- (void)openBrowser:(id)sender {
    [statusPopover performClose:sender];
    goMenuOpen();
}
- (void)configure:(id)sender {
    [statusPopover performClose:sender];
    goMenuConfigure();
}
- (void)quit:(id)sender {
    [statusPopover performClose:sender];
    goMenuQuit();
}
@end

void proPresenterMenuStart(const char *accessURL) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    statusItem.button.title = @"PR";
    statusItem.button.toolTip = @"ProPresenter Remote";

    menuDelegate = [[ProPresenterMenuDelegate alloc] init];
    statusItem.button.target = menuDelegate;
    statusItem.button.action = @selector(togglePopover:);

    statusPopover = [[NSPopover alloc] init];
    statusPopover.behavior = NSPopoverBehaviorTransient;
    statusPopover.contentViewController = popoverController([NSString stringWithUTF8String:accessURL]);
}

void proPresenterMenuRun(void) {
    [NSApp run];
}

void proPresenterMenuQuit(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
    });
}
