# Writes the license texts a game exported with this engine has to ship, from
# the engine itself:
#   godot --headless --script <this file> -- <output dir>
# GODOT-LICENSE.txt is Godot's own MIT license; GODOT-THIRDPARTY.txt lists every
# third-party component compiled into the engine, with its copyright and license.
extends SceneTree


func _initialize() -> void:
	var out: String = OS.get_cmdline_user_args()[0]
	DirAccess.make_dir_recursive_absolute(out)
	_write(out.path_join("GODOT-LICENSE.txt"), Engine.get_license_text())

	var lines := PackedStringArray()
	for component in Engine.get_copyright_info():
		lines.append("%s" % component.name)
		for part in component.parts:
			for holder in part.copyright:
				lines.append("  Copyright %s" % holder)
			lines.append("  License: %s" % part.license)
		lines.append("")
	var licenses := Engine.get_license_info()
	for license_name in licenses:
		lines.append("---- %s ----" % license_name)
		lines.append(licenses[license_name])
		lines.append("")
	_write(out.path_join("GODOT-THIRDPARTY.txt"), "\n".join(lines))
	quit()


func _write(path: String, text: String) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(text)
	f.close()
