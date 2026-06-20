import os
from glob import glob

from setuptools import find_packages, setup

package_name = 'guide_mate_explorer'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.launch.py')),
        (os.path.join('share', package_name, 'config'), glob('config/*.yaml')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='Kalhar Pandya',
    maintainer_email='kalharpandya38@gmail.com',
    description='BFS frontier explorer for autonomous mapping on the TurtleBot 4 (guide-mate).',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'bfs_explorer = guide_mate_explorer.bfs_explorer:main',
            'glass_guard = guide_mate_explorer.glass_guard:main',
            'depth_lidar_fusion = guide_mate_explorer.depth_lidar_fusion:main',
        ],
    },
)
