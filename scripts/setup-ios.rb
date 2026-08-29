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
