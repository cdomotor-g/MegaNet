#!/usr/bin/env python3
"""
import_twin.py — open a MegaNet digital twin (.glb) in Blender with the scene
set up: metres, z up, a sun from the north, a camera looking at the pole, and
the station's coordinates on the scene where a render or a later script can
read them.

WHY THIS EXISTS
    The Digital Twin tab downloads one station's patch of ground — the real
    relief, the aerial imagery draped over it, a 2 m × 300 mm pole where the
    station stands and a 1.75 m figure beside it — as a glTF binary. Blender
    opens that with File → Import → glTF 2.0 and nothing more, and every
    object arrives in metres with the imagery already on the ground.

    What the importer does not do is the ten clicks after that: units, a
    light that is not the default point lamp in the corner, a camera framed
    on the pole rather than on the origin of an empty scene, and the
    station's latitude, longitude and height — which the app writes into the
    file's header — carried somewhere Blender keeps. This script is those
    ten clicks, and it is the only thing in this directory that needs
    Blender's Python rather than the system one.

WHAT IT READS
    The .glb's JSON header, straight off the file with the standard library,
    before Blender's importer sees it. The app writes `asset.extras` with the
    station id, name and number, the origin's lat/lon and AHD height, the
    ground's source and sample spacing, the imagery's source, and the pole
    and figure dimensions. Blender's importer drops `asset.extras` (it keeps
    node extras only), so they are read here and written onto the scene as
    custom properties — `bpy.context.scene["meganet_station"]` and so on.

COORDINATES
    glTF is y-up and the app writes x east, y up, z south, with the origin on
    the ground at the pole. Blender's importer turns that into its own z-up:
    x east, y north, z up. So after import the pole stands at (0, 0, 0)
    pointing +z, the figure is a metre east of it, and a camera to the
    south-west looks north-east at both.

USAGE
    blender --background --python tools/blender/import_twin.py -- twin-loudoun_br_al-400m.glb
    blender --background --python tools/blender/import_twin.py -- twin.glb --save twin.blend
    blender --background --python tools/blender/import_twin.py -- twin.glb --render twin.png
    blender --python tools/blender/import_twin.py -- twin.glb          # and stay open

    Everything after `--` is this script's; Blender stops reading there.

    --save <file.blend>   write the set-up scene out
    --render <file.png>   render the camera's view with EEVEE and write it
    --keep                keep Blender's default cube, light and camera
"""

import json
import math
import os
import struct
import sys

try:
    import bpy
    from mathutils import Vector
except ImportError:  # pragma: no cover — run under Blender, not the system python
    sys.exit("This script runs inside Blender:\n"
             "  blender --background --python tools/blender/import_twin.py -- <twin.glb>")


def glb_header(path):
    """The JSON chunk of a .glb, parsed — the app's `asset.extras` live there."""
    with open(path, 'rb') as fh:
        magic, version, _length = struct.unpack('<III', fh.read(12))
        if magic != 0x46546C67 or version != 2:
            raise SystemExit(f"{path}: not a glTF 2.0 binary")
        chunk_len, chunk_type = struct.unpack('<II', fh.read(8))
        if chunk_type != 0x4E4F534A:
            raise SystemExit(f"{path}: first chunk is not JSON")
        return json.loads(fh.read(chunk_len).decode('utf-8'))


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not argv:
        raise SystemExit(__doc__)
    opts = {'glb': None, 'save': None, 'render': None, 'keep': False}
    it = iter(argv)
    for a in it:
        if a == '--save':
            opts['save'] = next(it, None)
        elif a == '--render':
            opts['render'] = next(it, None)
        elif a == '--keep':
            opts['keep'] = True
        elif opts['glb'] is None:
            opts['glb'] = a
        else:
            raise SystemExit(f"unexpected argument {a!r}")
    if not opts['glb'] or not os.path.isfile(opts['glb']):
        raise SystemExit(f"no such .glb: {opts['glb']!r}")
    return opts


def clear_default_scene():
    for obj in list(bpy.data.objects):
        if obj.name in ('Cube', 'Light', 'Camera'):
            bpy.data.objects.remove(obj, do_unlink=True)


def main():
    opts = parse_args()
    header = glb_header(opts['glb'])
    extras = (header.get('asset') or {}).get('extras') or {}

    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = 'METERS'
    if not opts['keep']:
        clear_default_scene()

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(opts['glb']))
    imported = [o for o in bpy.data.objects if o not in before]

    # The station, on the scene, where a render note or a later script finds it.
    origin = extras.get('origin') or {}
    scene['meganet_station'] = extras.get('station_id') or ''
    scene['meganet_station_name'] = extras.get('station_name') or ''
    scene['meganet_station_number'] = extras.get('station_number') or ''
    scene['meganet_origin_lat'] = float(origin.get('lat') or 0.0)
    scene['meganet_origin_lon'] = float(origin.get('lon') or 0.0)
    scene['meganet_origin_height_m'] = float(origin.get('ground_m') or 0.0)
    scene['meganet_origin_datum'] = origin.get('datum') or ''
    scene['meganet_ground_source'] = json.dumps(extras.get('ground') or {})
    scene['meganet_imagery'] = json.dumps(extras.get('imagery') or {})

    # The sun from the north (this is the southern hemisphere), 55° up — the
    # same light the tab draws with, so the render and the tab agree about
    # which side of the pole is in shadow.
    sun_data = bpy.data.lights.new('Sun', type='SUN')
    sun_data.energy = 4.0
    sun_data.angle = math.radians(1.5)
    sun = bpy.data.objects.new('Sun', sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(35.0), 0.0, math.radians(180.0))

    # A camera to the south-west, looking north-east at the pole and the figure.
    cam_data = bpy.data.cameras.new('Camera')
    cam_data.lens = 35.0
    cam_data.clip_end = 5000.0
    cam = bpy.data.objects.new('Camera', cam_data)
    scene.collection.objects.link(cam)
    cam.location = Vector((-11.0, -14.0, 6.5))
    look_at = Vector((0.6, 0.0, 1.0))
    cam.rotation_euler = (look_at - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    # A sky, so the ground's edge does not fade into black.
    world = scene.world or bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.62, 0.78, 0.94, 1.0)
        bg.inputs[1].default_value = 1.0

    ground = next((o for o in imported if o.name.startswith('ground')), None)
    print(f"Imported {len(imported)} object(s) from {opts['glb']}")
    print(f"  station: {scene['meganet_station_name']} ({scene['meganet_station']}) "
          f"at {scene['meganet_origin_lat']:.5f}, {scene['meganet_origin_lon']:.5f}, "
          f"ground {scene['meganet_origin_height_m']:.2f} m {scene['meganet_origin_datum']}")
    if ground is not None:
        print(f"  ground mesh: {len(ground.data.vertices)} vertices, "
              f"{'textured' if ground.data.materials and ground.data.materials[0].use_nodes else 'untextured'}")

    if opts['render']:
        scene.render.engine = 'BLENDER_EEVEE_NEXT' if hasattr(bpy.types, 'SceneEEVEE') and 'BLENDER_EEVEE_NEXT' in \
            [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
        scene.render.resolution_x = 1920
        scene.render.resolution_y = 1080
        scene.render.filepath = os.path.abspath(opts['render'])
        bpy.ops.render.render(write_still=True)
        print(f"  rendered {scene.render.filepath}")

    if opts['save']:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(opts['save']))
        print(f"  saved {opts['save']}")


main()
