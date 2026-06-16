# Attack Surface Analyzer Commands for vMix License Investigation
# Three-step collection approach to identify persistent license acceptance artifacts

# Step 1: Take baseline snapshot of clean system (before any vMix installation)
# -a flag enables all collectors (registry, files, services, processes, etc.)
asa collect --runid "clean-system" -a

# Step 2: Install vMix manually, accept the license dialog, let it complete installation
# Then take snapshot to capture all system changes during installation
asa collect --runid "vmix-installed" -a

# Step 3: Uninstall vMix completely using Windows Add/Remove Programs
# Then take final snapshot to see what remains after uninstallation
asa collect --runid "after-uninstall" -a

# Step 4: Compare clean system vs after uninstall - THIS IS THE KEY COMPARISON
# Shows ONLY what persisted after uninstallation (license acceptance artifacts)
asa export-collect --firstrunid "clean-system" --secondrunid "after-uninstall"

# Optional: Additional comparisons for full analysis
# asa export-collect --firstrunid "clean-system" --secondrunid "vmix-installed"     # Full installation changes
# asa export-collect --firstrunid "vmix-installed" --secondrunid "after-uninstall" # What got removed during uninstall

