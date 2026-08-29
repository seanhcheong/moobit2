//
//  Registers the Swift frame processor plugin with VisionCamera.
//
//  VisionCamera looks plugins up by name in an Objective-C registry, and a pure-Swift class cannot
//  add itself to it. This file exists solely to run that registration and hand VisionCamera an
//  initialiser for the Swift plugin, under the name the JS side calls ("detectPose", see
//  src/app/frame/usePosePipeline.ts).
//
//  `VISION_EXPORT_SWIFT_FRAME_PROCESSOR` is VisionCamera's own macro for this. Using it rather than
//  a hand-written `+load` matters for two reasons: it gets the initialiser selector right
//  (`initWithProxy:withOptions:`, which is easy to mis-remember), and it registers via
//  `__attribute__((constructor))` instead of `+load`. That distinction is not cosmetic — when pods
//  are built as static libraries, a `+load` in a class the linker sees no other reference to can be
//  stripped, and the symptom is a working camera with a plugin that silently never exists.
//
//  `MoobitRecog-Swift.h` is the GENERATED Swift interface header, which Xcode produces automatically
//  for any target containing Swift. Its name is "<PRODUCT_MODULE_NAME>-Swift.h", so renaming the
//  Xcode target means renaming this import. No bridging header is involved or needed: a bridging
//  header is for the opposite direction, ObjC into Swift.
//
#import <VisionCamera/FrameProcessorPlugin.h>
#import "MoobitRecog-Swift.h"

VISION_EXPORT_SWIFT_FRAME_PROCESSOR(PoseFrameProcessorPlugin, detectPose)
