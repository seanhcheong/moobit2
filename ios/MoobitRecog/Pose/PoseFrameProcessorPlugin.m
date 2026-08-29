//
//  Registers the Swift frame processor plugin with VisionCamera.
//
//  VisionCamera looks plugins up by name in an Objective-C registry, and a pure-Swift class
//  cannot add itself to it at load time. This tiny ObjC shim exists solely to run `+load` and
//  hand VisionCamera an initialiser for the Swift plugin, under the name the JS side calls
//  ("detectPose", see src/app/frame/usePosePlugin.ts).
//
//  `MoobitRecog-Swift.h` is the generated Swift interop header. Its name is
//  "<PRODUCT_MODULE_NAME>-Swift.h", so if the Xcode target is ever renamed this import must be
//  renamed with it.
//
#import <VisionCamera/FrameProcessorPluginRegistry.h>
#import "MoobitRecog-Swift.h"

@interface PoseFrameProcessorPluginRegistration : NSObject
@end

@implementation PoseFrameProcessorPluginRegistration

+ (void)load {
  [FrameProcessorPluginRegistry
      addFrameProcessorPlugin:@"detectPose"
              withInitializer:^FrameProcessorPlugin* _Nonnull(VisionCameraProxyHolder* _Nonnull proxy,
                                                              NSDictionary* _Nullable options) {
                return [[PoseFrameProcessorPlugin alloc] initWithProxy:proxy options:options];
              }];
}

@end
