#!/usr/bin/env ruby
# frozen_string_literal: true

#
# Adds the native pose plugin sources and the MediaPipe model to the iOS app target.
#
#   bundle exec ruby scripts/setup-ios.rb
#
# ## Why this script exists
# Creating a file on disk does not add it to an Xcode target. The three plugin sources under
# ios/MoobitRecog/Pose/ and the pose_landmarker_*.task model all have to be registered in
# project.pbxproj, and without that the app builds and launches perfectly, shows a live camera,
# and the frame processor plugin simply never exists — which surfaces as "camera works, no
# skeleton, no error". Dragging the files into Xcode by hand does the same job; this makes it
# repeatable and reviewable.
#
# It uses the `xcodeproj` gem, which is what CocoaPods itself uses to rewrite pbxproj files, so
# the output is valid by construction rather than by hand-editing. Already in the Gemfile.
#
# Idempotent: re-running adds nothing and reports what it found.
#
# Nothing here is needed on Android — Gradle compiles everything under src/main/java and picks up
# assets automatically.
#

require 'xcodeproj'
require 'pathname'

ROOT = Pathname.new(__dir__).parent
PROJECT_PATH = ROOT / 'ios' / 'MoobitRecog.xcodeproj'
TARGET_NAME = 'MoobitRecog'
APP_GROUP = 'MoobitRecog'

# Compiled into the target. Paths are relative to ios/, matching the template's own convention.
SOURCES = [
  'MoobitRecog/Pose/PoseLandmarkerHolder.swift',
  'MoobitRecog/Pose/PoseFrameProcessorPlugin.swift',
  'MoobitRecog/Pose/PoseFrameProcessorPlugin.m'
].freeze

# Copied into the bundle. Whichever model variants have actually been downloaded.
MODEL_GLOB = 'MoobitRecog/pose_landmarker_*.task'

abort "Cannot find #{PROJECT_PATH}" unless PROJECT_PATH.exist?

# ---------------------------------------------------------------------------------------------
# Preflight: is a full Xcode actually available?
#
# Apple's standalone Command Line Tools can compile for macOS but ship NO iOS SDK. With only
# those installed, `pod install` gets a long way in and then dies inside glog's configure script
# with about a hundred lines of autoconf output whose actual cause is one buried line,
# `xcrun: error: SDK "iphoneos" cannot be located`. That is a miserable first-run experience for
# something this easy to detect, so detect it here and say it in one sentence.
# ---------------------------------------------------------------------------------------------
def tool_output(cmd)
  out = `#{cmd} 2>/dev/null`.strip
  $?.success? ? out : nil
rescue StandardError
  nil
end

developer_dir = tool_output('xcode-select -p')
xcode_version = tool_output('xcodebuild -version')
ios_sdk = tool_output('xcrun --sdk iphoneos --show-sdk-path')

if developer_dir.nil? || xcode_version.to_s.empty? || ios_sdk.to_s.empty?
  warn <<~XCODE

    #{'=' * 74}
    FULL XCODE IS REQUIRED, AND IS NOT SET UP
    #{'=' * 74}

    xcode-select -p        -> #{developer_dir || '(failed)'}
    xcodebuild -version    -> #{xcode_version.to_s.empty? ? '(empty/failed)' : xcode_version.lines.first.strip}
    iphoneos SDK path      -> #{ios_sdk.to_s.empty? ? '(NOT FOUND)' : ios_sdk}

    Apple's standalone Command Line Tools cannot build for iOS — they contain no iOS SDK.
    Without a full Xcode, `pod install` fails deep inside glog's configure script with a wall
    of autoconf output whose real cause is one line: 'SDK "iphoneos" cannot be located'.

    If Xcode IS installed but the active developer directory points at CommandLineTools:

        sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
        sudo xcodebuild -license accept
        xcodebuild -runFirstLaunch

    If Xcode is NOT installed, get it from the Mac App Store (~10 GB), open it once to finish
    installing components, then run the three commands above.

    Then verify (this must print a version, not an error):

        xcodebuild -version

    If a previous `pod install` already failed, clear the poisoned cache first:

        rm -rf ~/Library/Caches/CocoaPods ios/Pods ios/Podfile.lock

    Android needs none of this: `npm run setup:android && npm run android`.
    #{'=' * 74}

  XCODE
  abort 'Aborting before touching the Xcode project. Fix the toolchain above and re-run.'
end

project = Xcodeproj::Project.open(PROJECT_PATH.to_s)
target = project.targets.find { |t| t.name == TARGET_NAME }
abort "No target named #{TARGET_NAME}. Targets: #{project.targets.map(&:name).join(', ')}" if target.nil?

app_group = project.main_group[APP_GROUP]
abort "No group named #{APP_GROUP} in the project" if app_group.nil?

# A group for the plugin sources, so they are navigable in Xcode rather than loose.
pose_group = app_group.children.find { |c| c.display_name == 'Pose' && c.is_a?(Xcodeproj::Project::Object::PBXGroup) }
if pose_group.nil?
  pose_group = app_group.new_group('Pose')
  puts 'created group: Pose'
end

# Index every path already referenced anywhere, so re-running is a no-op even if a file was added
# by hand into a different group.
existing_paths = project.files.map(&:path).compact.to_set

def in_phase?(phase, path)
  phase.files_references.compact.any? { |r| r.path == path }
end

added_sources = []
skipped_sources = []

SOURCES.each do |rel|
  abs = ROOT / 'ios' / rel
  unless abs.exist?
    warn "  MISSING ON DISK, skipping: #{rel}"
    next
  end

  ref = project.files.find { |f| f.path == rel }
  if ref.nil?
    ref = pose_group.new_reference(rel)
    existing_paths << rel
  end

  if in_phase?(target.source_build_phase, rel)
    skipped_sources << rel
  else
    target.source_build_phase.add_file_reference(ref, true)
    added_sources << rel
  end
end

added_resources = []
skipped_resources = []

Dir.glob((ROOT / 'ios' / MODEL_GLOB).to_s).sort.each do |abs|
  rel = Pathname.new(abs).relative_path_from(ROOT / 'ios').to_s

  ref = project.files.find { |f| f.path == rel }
  ref = app_group.new_reference(rel) if ref.nil?

  if in_phase?(target.resources_build_phase, rel)
    skipped_resources << rel
  else
    target.resources_build_phase.add_file_reference(ref, true)
    added_resources << rel
  end
end

project.save

puts
puts '=' * 74
puts 'iOS project setup'
puts '=' * 74
puts "target: #{target.name}"

if added_sources.empty? && skipped_sources.any?
  puts "\nCompile Sources: already complete (#{skipped_sources.size} plugin files present)"
else
  puts "\nCompile Sources:"
  added_sources.each { |p| puts "  + #{p}" }
  skipped_sources.each { |p| puts "  = #{p} (already there)" }
end

if added_resources.empty? && skipped_resources.empty?
  puts "\nCopy Bundle Resources: NO MODEL FOUND."
  puts '  Run `npm run model:download` first, then re-run this script.'
  puts '  Without the model in the bundle the landmarker cannot initialise at runtime.'
else
  puts "\nCopy Bundle Resources:"
  added_resources.each { |p| puts "  + #{p}" }
  skipped_resources.each { |p| puts "  = #{p} (already there)" }
end

puts "\nFinal state of the target:"
puts "  sources   (#{target.source_build_phase.files.count}): " \
     "#{target.source_build_phase.files_references.compact.map(&:display_name).sort.join(', ')}"
puts "  resources (#{target.resources_build_phase.files.count}): " \
     "#{target.resources_build_phase.files_references.compact.map(&:display_name).sort.join(', ')}"

puts <<~NEXT

  Next:
    cd ios && pod install && cd ..
    npm run ios          # or open ios/MoobitRecog.xcworkspace and run from Xcode

  Note there is no bridging header to create. PoseFrameProcessorPlugin.m imports the GENERATED
  Swift interface header (MoobitRecog-Swift.h), which Xcode produces automatically for any target
  containing Swift. A bridging header is only for the opposite direction, ObjC into Swift, and
  nothing here needs that. If Xcode offers to create one, declining is correct.
NEXT
