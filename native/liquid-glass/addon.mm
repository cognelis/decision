#define NAPI_VERSION 8
#include <node_api.h>

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

#include <cstdint>
#include <cstring>

static const void *kDecisionGlassKey = &kDecisionGlassKey;

API_AVAILABLE(macos(26.0))
@interface DecisionGlassView : NSGlassEffectView
@property(nonatomic) BOOL decisionBottomCornersOnly;
@property(nonatomic) CGFloat decisionCornerRadius;
@end

@implementation DecisionGlassView

- (void)layout {
  [super layout];
  self.wantsLayer = YES;
  if (!self.decisionBottomCornersOnly) {
    self.layer.mask = nil;
    self.cornerRadius = self.decisionCornerRadius;
    self.layer.cornerCurve = kCACornerCurveContinuous;
    return;
  }

  self.cornerRadius = 0;
  const CGRect bounds = NSRectToCGRect(self.bounds);
  const CGFloat radius = MIN(
      self.decisionCornerRadius,
      MIN(CGRectGetWidth(bounds), CGRectGetHeight(bounds)) / 2.0);
  const CGFloat minX = CGRectGetMinX(bounds);
  const CGFloat maxX = CGRectGetMaxX(bounds);
  const CGFloat minY = CGRectGetMinY(bounds);
  const CGFloat maxY = CGRectGetMaxY(bounds);

  CGMutablePathRef path = CGPathCreateMutable();
  if (self.isFlipped) {
    CGPathMoveToPoint(path, nullptr, minX, minY);
    CGPathAddLineToPoint(path, nullptr, maxX, minY);
    CGPathAddLineToPoint(path, nullptr, maxX, maxY - radius);
    CGPathAddArcToPoint(
        path,
        nullptr,
        maxX,
        maxY,
        maxX - radius,
        maxY,
        radius);
    CGPathAddLineToPoint(path, nullptr, minX + radius, maxY);
    CGPathAddArcToPoint(
        path,
        nullptr,
        minX,
        maxY,
        minX,
        maxY - radius,
        radius);
  } else {
    CGPathMoveToPoint(path, nullptr, minX, maxY);
    CGPathAddLineToPoint(path, nullptr, maxX, maxY);
    CGPathAddLineToPoint(path, nullptr, maxX, minY + radius);
    CGPathAddArcToPoint(
        path,
        nullptr,
        maxX,
        minY,
        maxX - radius,
        minY,
        radius);
    CGPathAddLineToPoint(path, nullptr, minX + radius, minY);
    CGPathAddArcToPoint(
        path,
        nullptr,
        minX,
        minY,
        minX,
        minY + radius,
        radius);
  }
  CGPathCloseSubpath(path);

  CAShapeLayer *mask = [CAShapeLayer layer];
  mask.frame = self.bounds;
  mask.path = path;
  self.layer.mask = mask;
  CGPathRelease(path);
}

@end

static napi_value MakeResult(
    napi_env env,
    bool applied,
    const char *reason) {
  napi_value result;
  napi_value appliedValue;
  napi_value reasonValue;
  napi_create_object(env, &result);
  napi_get_boolean(env, applied, &appliedValue);
  napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &reasonValue);
  napi_set_named_property(env, result, "applied", appliedValue);
  napi_set_named_property(env, result, "reason", reasonValue);
  return result;
}

static bool ReadStringOption(
    napi_env env,
    napi_value options,
    const char *name,
    char *output,
    size_t outputLength) {
  napi_value value;
  if (napi_get_named_property(env, options, name, &value) != napi_ok) {
    return false;
  }
  size_t written = 0;
  return napi_get_value_string_utf8(
             env,
             value,
             output,
             outputLength,
             &written) == napi_ok;
}

static double ReadNumberOption(
    napi_env env,
    napi_value options,
    const char *name,
    double fallback) {
  napi_value value;
  double result = fallback;
  if (
      napi_get_named_property(env, options, name, &value) == napi_ok &&
      napi_get_value_double(env, value, &result) == napi_ok) {
    return result;
  }
  return fallback;
}

static napi_value ApplyGlass(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 2) {
    return MakeResult(env, false, "missing_arguments");
  }

  bool isBuffer = false;
  napi_is_buffer(env, args[0], &isBuffer);
  if (!isBuffer) {
    return MakeResult(env, false, "native_handle_not_buffer");
  }

  void *bufferData = nullptr;
  size_t bufferLength = 0;
  napi_get_buffer_info(env, args[0], &bufferData, &bufferLength);
  if (bufferLength < sizeof(uintptr_t)) {
    return MakeResult(env, false, "native_handle_too_short");
  }

  uintptr_t pointerValue = 0;
  std::memcpy(&pointerValue, bufferData, sizeof(pointerValue));
  NSView *rootView =
      (__bridge NSView *)reinterpret_cast<void *>(pointerValue);
  if (rootView == nil) {
    return MakeResult(env, false, "native_view_missing");
  }

  if (@available(macOS 26.0, *)) {
    char style[16] = {};
    char corners[16] = {};
    ReadStringOption(env, args[1], "style", style, sizeof(style));
    ReadStringOption(env, args[1], "corners", corners, sizeof(corners));
    if (std::strcmp(style, "regular") != 0) {
      return MakeResult(env, false, "unsupported_glass_style");
    }
    const CGFloat cornerRadius =
        ReadNumberOption(env, args[1], "cornerRadius", 18.0);

    DecisionGlassView *glass =
        objc_getAssociatedObject(rootView, kDecisionGlassKey);
    if (glass == nil) {
      glass =
          [[DecisionGlassView alloc] initWithFrame:rootView.bounds];
      glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      glass.tintColor = [NSColor colorWithSRGBRed:0.10
                                           green:0.58
                                            blue:0.46
                                           alpha:0.04];
      [rootView addSubview:glass
                positioned:NSWindowBelow
                relativeTo:nil];
      objc_setAssociatedObject(
          rootView,
          kDecisionGlassKey,
          glass,
          OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }

    glass.style = NSGlassEffectViewStyleRegular;
    glass.decisionBottomCornersOnly =
        std::strcmp(corners, "bottom") == 0;
    glass.decisionCornerRadius = MAX(0.0, cornerRadius);
    [glass setNeedsLayout:YES];
    [glass layoutSubtreeIfNeeded];
    return MakeResult(env, true, "liquid_glass_regular");
  }

  return MakeResult(env, false, "macos_26_required");
}

static napi_value Initialize(napi_env env, napi_value exports) {
  napi_value apply;
  napi_create_function(
      env,
      "applyGlass",
      NAPI_AUTO_LENGTH,
      ApplyGlass,
      nullptr,
      &apply);
  napi_set_named_property(env, exports, "applyGlass", apply);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
